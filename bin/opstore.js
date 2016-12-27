/**
 * Created by christianthindberg on 13/09/16.
 *
 * Operational Data Store for OsloMetro
 *
 * Abstracts away Redis from the other modules
 * Provides API to retrieve information on trains, berths, events etc for other modules
 * Also makes available some commands for management of the store (i.e. flushall, master)
 *
 * Enables the ctshistory module to playback events and to perform aggregations on data in the opstore
 *
 * Deletes data from Redis on regular intervarls to keep from overgrowing
 *
 */


"use strict";

let Redis = require("ioredis");
const os = require("os");
const flatten = require("flat");
const unflatten = require("flat").unflatten;
const schedule = require("node-schedule");
const assert = require("assert");
const logger = require("./logger");
const log = logger().getLogger("opstore");
const helpers = require("./helpers");

/*
let KafkaRest = require("kafka-rest");
let kafka = new KafkaRest({"url": "http://ec2-52-211-70-204.eu-west-1.compute.amazonaws.com:8082"});
//const logMemory = logger().getLogger("memory-usage");

 Just for testing
kafka.topics.list(function (err, topics) {
    if (err) {
        log.error ("kafka.topics.list. Unable to list topics: " + err);
        return;
    }
    for (let i=0; i < topics.length; i++) {
        console.log(topics[i].toString());
    }
});
*/

// max number of events to store
let maxCTS = os.platform() === "darwin" ? 5000 : 300000;

const redisEndpoint = os.platform() === "darwin" ? "" : "oslometro-redis.ezuesa.ng.0001.euw1.cache.amazonaws.com"; //oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com

const redisStore = new Redis(6379, redisEndpoint);
// used to receive subscription notifications
const redisSubscriberClient = new Redis(6379, redisEndpoint);
// used for testing
const pub = new Redis(6379, redisEndpoint);

log.info ("Redis connect: " + JSON.stringify(redisStore));

let Store = {
    version:1.0
};

Store.setMaxCTSEvents = function (max) {
    assert.ok(typeof max === "number", "Store.setMaxCTSEvents - max paramater is not number: " + max);
    maxCTS = max;
    return maxCTS;
};
Store.getMaxCTSEvents = function () {
  return maxCTS;
};

Store.getLastCTSEventID = function (callback) {
    assert.ok(typeof callback === "function");
    redisStore.get(k.ctsCounter, callback);
}; // getLastCTSEventID()

Store.countCTSEvents = function (callback) {
    assert.ok(typeof callback === "function");

    redisStore.zcount(k.ctsTimestamp, "-inf", "+inf", function (err, count) {
       callback (err, count);
    });
}; // countCTSEvents()

Store.getCTSEventByID = function (eventID, callback) {
    assert.ok(typeof callback === "function");
    assert.ok(typeof  eventID === "number");

    redisStore.hget(k.ctsEvents, eventID, function (err, result) {
        const flatmsgObject = JSON.parse(result);
        const msgObject = unflatten(flatmsgObject);
        callback (err, msgObject);
    });
}; // getCTSEventByID()


Store.getTrainNumbersLogical = function (callback) {
    assert.ok(typeof callback === "function");
    redisStore.smembers(k.trainlogKeys, callback);
}; // getTrainNumbersLogical()

Store.getFirstAndLastCTSEvent = function (callback) {
    assert.ok(typeof callback === "function");

    const multi = redisStore.multi();

    multi.zrange(k.ctsTimestamp, 0, 0, "withscores");
    multi.zrange(k.ctsTimestamp, -1, -1, "withscores");
    multi.exec(function (err, result) {
        callback(err,result);
    });
}; // getFirstAndLastCTSEvent()

// Each element holds the data and function to handle the corresponding stream or aggregate
let arrIntervals = [];
let arrStreams = [];

/**
 * createIntervalAggregator: adds together properties over a time intervel, i.e. every hour at 00 the current aggregate is delivered, and values are set to zero
 *      to start aggregating the next hour.
 * @param hashKey       : redis key for the hash we want to aggregate over
 * @param groupByProps  : Array containing strings identical to the hash field/properties ("Line", "Station", ...) by which we want to group
 * @param addProps      : Array containing strings identical to the hash field/properties ("Aligth", "Board") that we want to sum
 * @param timeSchedule  : Periodic time where we deliver our aggregate and resets all values to zero to start a new aggregation period
 * @param callback      : function to call to serve aggregated data back to caller
 */
let countIntervalCreate = 0; // for debug

Store.createStreamFixedInterval = function (Name, groupByProps, addProps, timeSchedule, fnIntervalCompleted, fnDataAdded) {
    assert (typeof Name === "string");
    assert (Array.isArray(groupByProps));
    assert (Array.isArray(addProps));
    assert (typeof timeSchedule === "object");
    assert (typeof fnIntervalCompleted === "function");
    assert (typeof fnDataAdded === "function" || fnDataAdded === null);

    let groupByObj = {};

    countIntervalCreate += 1;
    log.info ("createStreamFixedInterval called: " + countIntervalCreate);

    let Stream = new FixedInterval (Name, groupByProps, addProps, timeSchedule, fnIntervalCompleted, fnDataAdded);
    arrIntervals.push(Stream);
    schedule.scheduleJob (timeSchedule, Stream.completeFixedIntervalAggregate.bind(Stream));
    return Stream;
}; // createStreamFixedInterval()

function FixedInterval (Name, groupByProps, addProps, timeSchedule, fnIntervalCompleted, fnDataAdded) {
    this.Name               = Name;
    this.Count              = 0; // todo: implement count === number of events in stream
    this.intervalCompleted  = fnIntervalCompleted;
    this._dataAdded          = fnDataAdded;
    //this.bBlock             = false; //
    this.addProps           = addProps;
    this.timeSchedule       = timeSchedule;
    this.aggObj             = {};       // the aggregate we are currently building (if interval is 1 hour and current time is 11.30
                                        // we are halfway through building the interval from 11 to 12)
    this.aggObjLatest       = null;     // the newest aggregate that we have completed (i.e. the aggregate from 10 to 11 if time now is 11.30)
    this.aggObjTemplate     = null;     // template used by completeFixedIntervalAggregate for creating new "empty" aggObj when interval is completed

    this.dataAdded = function () { // this._dataAdded is null if caller do not want notifications whenever data is added
        if (this._dataAdded) {
            this._dataAdded(null, this.aggObj);
        }
    };

    // build aggObj
    for (let i=0; i<groupByProps.length;i++) {
        this.aggObj[groupByProps[i]] = {};
    }

    // make a copy of the groupByObj to use as a template for calculating data leaving the stream
    this.aggObjTemplate = JSON.parse(JSON.stringify(this.aggObj));
    // make a copy of the groupByObj so that getFixedIntervalAggregate always returns an aggObj, even though it is initially empty
    this.aggObjLatest = JSON.parse(JSON.stringify(this.aggObj));
    return this;
} // FixedInterval


FixedInterval.prototype.saveAPCAggregate = function () {
    let self = this; // avoid "loosing" this when doing async stuff
    redisStore.incr(km(k.apcAggregateCounter, self.Name), function (err, eID) {
        if (err) {
            log.error("saveAPCAggregate. Unable to increment APCCounter: " + err.msg + "eID: " + eID);
            return;
        }
        else {
            let multi = redisStore.multi();
            //let test = self.timeSchedule;
            //let hr = self.timeSchedule.hour ? self.timeSchedule.hour : 0;
            //let min = self.timeSchedule.minute ? self.timeSchedule.minute: 0;
            //let sec = self.timeSchedule.second ? self.timeSchedule.second : 0;
            //let scheduleKey = hr.toString() + ":" + min.toString() + ":" + sec.toString();
            let timeNow = new Date ().getTime(); //.HrMinSecToMillis(hr, min, sec);
            multi.hset(km(k.apcAggEvents, self.Name), apcPrefix + eID, JSON.stringify(flatten(self.aggObj)));
            // secondary index for all aggregate events
            multi.zadd(km(k.apcAggTimestamp, self.Name), timeNow, apcPrefix + eID);
            multi.exec(function (err, reply) {
                if (err) {
                    log.error("saveAPCAggregate. Error saving aggregate to Redis: " + err.message);
                }
                else {
                    log.info("saveAPCAggregate. Succesfully saved aggregate to Redis.");
                }
            });
        }
    }); // save aggregate to Redis
}; // saveAPCAggregate()

/**
 * prototype.completeFixedIntervalAggregate
 *
 * The job of completeFixedIntervalAggregate is to
 * a) save the hourly aggregate to Redis
 * b) send the aggregate to callback intervalCompleted
 * c) keep a copy of the finished aggregate, ready for getLatestFixedInterval to retrieve it
 * d) reset the aggobj so it is ready for the next hour/fixed interval
 */
FixedInterval.prototype.completeFixedIntervalAggregate = function () {
    // save to Redis
    this.saveAPCAggregate ();
    // invoke callback intervalCompleted
    this.intervalCompleted (null, this.aggObj);
    // remember this aggregate as our latest completed aggregate
    this.aggObjLatest = this.aggObj;
    // reset aggObj
    this.aggObj = JSON.parse(JSON.stringify(this.aggObjTemplate));
    this.Count = 0;
}; // completeFixedIntervalAggregate ()

FixedInterval.prototype.getLastCompletedAggregate = function () {
    return this.aggObjLatest;
}; // getLastCompletedAggregate

FixedInterval.prototype.getCount = function () {
    return this.Count;
}; // getCount()

FixedInterval.prototype.getOngoingAggregate = function () {
    return this.aggObj;
}; // getOngoingAggregate()

/**
 * createStreamSlidingWindow: adds together properties over a "stream" (i.e. time window of f.ex 20 minutes, updated every 10 seconds)
 *
 * @param Name          : Redis key for the hash we want to store our aggregates into
 * @param groupByProps  : Array containing strings identical to the hash field/properties ("Line", "Station", ...) by which we want to group
 * @param addProps      : Array containing strings identical to the hash field/properties ("Alight", "Board") that we want to sum
 * @param length        : Length of the stream, i.e. 20 minutes
 * @param timeSchedule  : timedelta, i.e. how often we update the stream data (ex every 10 seconds
 * @param callback      : function to call to serve aggregated data back  to caller
 *
 */
let countStreamCreate = 0; // for debug

Store.createStreamSlidingWindow = function (Name, groupByProps, addProps, length, timeSchedule, callback) {
    assert (typeof Name === "string");
    assert (Array.isArray(groupByProps));
    assert (Array.isArray(addProps));
    assert (typeof length === "number");
    assert (typeof timeSchedule === "object");
    assert (typeof callback === "function");

    countStreamCreate += 1;
    log.info ("createStreamAggregator called: " + countStreamCreate);

    let Stream = new SlidingWindow (Name, groupByProps, addProps, length, callback);
    arrStreams.push(Stream);
    schedule.scheduleJob (timeSchedule, Stream.calcSlidingWindowAggregate.bind(Stream));
    return Stream;
}; // createStreamAggregator()

/**
 * Constructor SlidingWindow
 *
 * @param Name:             Name of the Redis hash set to retrieve data from. Not implemented at the moment. Only support for APC/passenger counting
 * @param groupByProps      Array of properties ["Line", "Station", "Module"] by which to aggregate data
 * @param addProps          Array of properties to add, i.e. ["Alight", "Board]
 * @param length            The length of the stream/sliding time window in milliseconds
 * @param callback          the function to serve the aggregated data back to the caller
 */
function SlidingWindow (Name, groupByProps, addProps, length, callback) {
    this.Name               = Name;
    this.length             = length; // sliding time window in milliseconds
    this.timeFirstCall      = 0;
    this.timeWindowStart    = 0;
    this.timeWindowEnd      = 0;
    this.timeNow            = 0;
    this.Count              = 0;
    this.callback           = callback;
    this.bBlock             = false; // ensure we do not do calcSlidingWindowAggregate while still executing previous call
    this.addProps           = addProps;

    this.aggObj = {};
    this.aggMinusObjTemplate = null;

    // build the groupByObj
    for (let i=0; i<groupByProps.length;i++) {
        this.aggObj[groupByProps[i]] = {};
    }
    // make a copy of the groupByObj to use as a template for calculating data leaving the stream
    this.aggMinusObjTemplate = JSON.parse(JSON.stringify(this.aggObj));
    return this;
} // SlidingWindow

// Beware of nesting...
/**
 *
 * SlidingWindow.prototype.calcSlidingWindowAggregate -- called at regular interval, f.ex every 10th second, and calclulate the aggregate (i.e. total number of boarding, alighting)
 *                          over a given period (ex. 20 minutes)
 *                          Since we are called regularly there is no need to recalculate the full 20 minute periode. We only calculate the newest 10 second period and the 10 second period
 *                          that is now too old to be part of the 20 min aggregate.
 *
 *                          Thus we implement a sliding time window, where we add the newest 10 seconds of data and remove the oldest 10 seconds
 *
 *                          Uses the variables stored in its instance of SlidingWindow to manage the "stream"
 */
SlidingWindow.prototype.calcSlidingWindowAggregate = function () {
    const self = this;  // "this" context is lost when doing async calls, so we store it in local variable
    const multi = redisStore.multi();
    self.timeNow = new Date().getTime();
    let aggMinusObj = JSON.parse(JSON.stringify(self.aggMinusObjTemplate)); // create a fresh empty minus object, i.e. all values set to zero

    if (self.bBlock) {
        log.info ("calcSlidingWindowAggregate. Called again while still calculating previous aggregate");
        return;
    }
    self.bBlock = true;

    if (self.timeFirstCall === 0) {
        self.timeFirstCall = self.timeNow;
        self.timeWindowStart = self.timeNow;
        self.timeWindowEnd = self.timeNow;
        self.bBlock = false;
        //self.callback (null, null);
        return; // No data to aggregate the first time, just initialize timers
    }

    // Initially, the stream has zero length and we start building it from timeNow
    // the stream grows until its time window is equal to length
    // after that we slide the time window forward by the time passed since we were last called

    // Retrieve new elements
    // The correct query once the APC deliver events in real time - retrieve events in the order they _occured
    //multi.zrangebyscore(km(k.apcTimestamp), self.timeWindowEnd, self.timeNow);
    // The query we have to use for now - retrieve events in the order they arrive to us
    multi.zrangebyscore(km(k.apcReceivedTimestamp), self.timeWindowEnd, self.timeNow);


    // Retrieve elements to subtract
    if (self.timeNow - self.length > self.timeWindowStart) {
        //multi.zrangebyscore(km(k.apcTimestamp), self.timeWindowStart, self.timeNow - self.length); // this will be the correct query once the APC deliver events in real time
        multi.zrangebyscore(k.apcReceivedTimestamp, self.timeWindowStart, self.timeNow - self.length);
    }

    multi.exec (function (err, reply) {
        const innermulti = redisStore.multi();

        if (err) {
            log.error("getACPEvents. Error retrieving apcKeys: " + err.message);
            self.bBlock = false;
            self.callback (err, self.aggObj);
            return;
        }

        let addEvents = reply[0][1];
        let minusEvents = [];

        if (reply.length === 2) {
            assert(self.timeNow - self.length > self.timeWindowStart);
            minusEvents = reply[1][1];
        }

        if (addEvents.length === 0 && minusEvents.length === 0) { // Nothing to proces, return ....
            // update sliding time window start and end times
            updateSlidingWindow(self);
            self.bBlock = false;
            self.callback (err, self.aggObj);
            return;
        }

        if (addEvents.length > 0) {
            innermulti.hmget(k.apcEvents, addEvents);
        }
        if (minusEvents.length > 0) {
            innermulti.hmget(k.apcEvents, minusEvents);
        }

        self.Count = self.Count + addEvents.length - minusEvents.length;

        innermulti.exec(function (err, innerreply) {
            let arrHashes = [];
            let arrMinusHashes = [];

            if (err) {
                log.error ("calcSlidingWindowAggregate. Error retrieving apcEvents: " + err.message);
                self.bBlock = false;
                self.callback (err, self.aggObj);
                return;
            }

            if (innerreply.length === 2) {
                arrHashes = innerreply [0][1];
                arrMinusHashes = innerreply [1][1];
            }
            else if (innerreply.length === 1 && addEvents.length > 0) {
                arrHashes = innerreply [0][1];
            }
            else if (innerreply.length === 1 && minusEvents.length > 0) {
                arrMinusHashes = innerreply [0][1];
            }
            else {
                assert ("Error. innerreply.length: " + innerreply.length + " innerreply[0]: " + innerreply[0]);
            }

            // Not so nice code, as the main thing going on here is the side effect of aggregateevents in changing the aggObj
            // accept it for compactness
            if (arrHashes.length > 0 && !aggregateEvents(self.aggObj, arrHashes, self.addProps)) {
                self.bBlock = false;
                self.callback (new Error("Unable to aggregate events"), self.aggObj);
                return;
            }
            if (arrMinusHashes.length > 0 && !aggregateEvents(aggMinusObj, arrMinusHashes, self.addProps)) {
                self.bBlock = false;
                self.callback (new Error ("Unable to aggregate minus events"), self.aggObj);
                return;
            }
            // subtract events...
            if (arrMinusHashes.length > 0) {
                subtractAggObjects (self.aggObj, aggMinusObj, self.addProps);
                log.info("calcSlidingWindowAggregate: Data left the stream: " + JSON.stringify(aggMinusObj));
            }

            updateSlidingWindow(self);
            self.bBlock = false;
            self.callback (err, self.aggObj);
            return;
        }); // hmget
    }); // zrangebyscore
}; // calcSlidingWindowAggregate()

function subtractAggObjects (aggObj, aggMinusObj, addProps) {
    assert(typeof aggObj === "object");
    assert(typeof aggMinusObj === "object");
    assert (Array.isArray(addProps));

    for (let prop in aggMinusObj) { // "Line", "Station", ...
        if (aggMinusObj.hasOwnProperty(prop) && aggObj.hasOwnProperty(prop)) {
            let specificMinusObj = aggMinusObj[prop];
            let specificAggObj = aggObj[prop];
            for (let p in specificMinusObj) { //"1", "2", "KOL", ...
                if (specificMinusObj.hasOwnProperty(p) && specificAggObj.hasOwnProperty(p)) {
                    for (let i = 0; i < addProps.length; i++) {
                        if (!specificAggObj[p].hasOwnProperty(addProps[i]) || !specificMinusObj[p].hasOwnProperty(addProps[i])) {
                            log.error("subtractAggObjects. Inconsistent objects. Missing property: " + addProps[i]);
                            continue;
                        }
                        specificAggObj[p][addProps[i]] -= specificMinusObj[p][addProps[i]];
                        if (specificMinusObj[p].hasOwnProperty("Count")) {
                            specificAggObj[p].Count -= specificMinusObj[p].Count;
                        }
                        else {
                            log.error("subtractAggObjects. specificMinusObj[" + p + "] missing Count property.");
                        }
                    } // inner inner for
                } // if
            } // inner for
        } // if
    } // outer for
} // subtractAggObjects ()

function updateSlidingWindow(streamObj) {
    assert (typeof streamObj === "object");
    if (streamObj.timeNow - streamObj.length > streamObj.timeWindowStart) {
        streamObj.timeWindowStart = streamObj.timeNow - streamObj.length;
    }
    streamObj.timeWindowEnd = streamObj.timeNow;
} // updateSlidingWindow()


/**
 *
 * aggregateEvents ()
 * Called by SlidingWindow. Accepts array of flattened apcEvents. Adds the events of the flat array to aggObj
 *
 * @param aggObj: {"Line":  {"1": {"Alight": a, "Board": b, "Count": c},
 *                          {"2": {"Alight": a, "Board": b, "Count": c},
 *                          .....}},
 *                 "Station": {"AMM": {"Alight": a, "Board": b, "Count": c},
*                              .... .... }},
*                   "Module":{"3023": {"Alight": a, "Board": b, "Count": c},
*                               ......}
 * @param arrHashes: array of flattened apcEvents
 * @param addProps: f.ex ["Line", "Station", "Module"], properties which respective values we want to sum
 * @returns aggObj where the apcEvents in arrHashes has been summed and added to each property
 */
function aggregateEvents (aggObj, arrHashes, addProps) {
    assert (typeof aggObj === "object");
    assert (Array.isArray(arrHashes));
    assert (Array.isArray(addProps));

    // iterate the events list
    for (let i=0; i < arrHashes.length; i++) {
        let apcEvent = unflatten(JSON.parse(arrHashes[i]));
        /* This is the structure of the apcEvent:
         apcEvent = {
            "Alight": a,
            "Board": b,
            "Timestamp": ts,
            "Line": l,
            "Station": s,
            "Module": m
         };
         */

        if (!apcEvent) {
            log.error ("aggregateEvents. retrieved apcEvent: null: ");
            return null;
        }

        addEventToAggregate(aggObj, apcEvent, addProps);
    } // for events list
    return aggObj;
} // aggregateEvents()

/**
 * addEventToAggregate
 * adds apcEvent to aggObj using the array of addProps to parse and add values
 * adds count property to each sub-aggregate to track number of events
 *
 * called by aggregateEvents for iteration over added and subtracted events. AggregateEvents is in turn is called by SlidingWindow
 * called by saveAPCEvent for iteration over new incoming events to create FixedInterval aggregates
 * @param aggObj
 * @param apcEvent
 * @param addProps
 * @returns {null}
 */
function addEventToAggregate (aggObj, apcEvent, addProps) {
    assert (typeof aggObj === "object");
    assert (typeof apcEvent === "object");
    assert (Array.isArray(addProps));

    // iterate the keys of the aggregator object - Line, Station, Module
    for (let j=0; j<Object.keys(aggObj).length; j++) {
        const generalKey = Object.keys(aggObj)[j];     // generalKey === "Line" || "Station" || "Module"
        let specificKey = null;    // ex 3, KOL, 30023
        let bData = false;

        if (!apcEvent.hasOwnProperty(generalKey)) {
            log.error("addEventToAggregate. Retrieved invalid apcEvent. Missing property: " + generalKey);
            return null;
        }
        specificKey = apcEvent[generalKey]; // 3, KOL, 30023, ...

        // first time we aggregate over this specificKey? Create the properties
        if (!aggObj[generalKey].hasOwnProperty(specificKey)) { // f.ex aggObj.Station.KOL
            aggObj[generalKey][specificKey] = {};
            for (let k=0; k<addProps.length; k++) {
                aggObj[generalKey][specificKey][addProps[k]] = 0; // { "Alight": 0, "Board": 0 };
            }
            aggObj[generalKey][specificKey].Count = 0;
        }

        for (let l=0; l<addProps.length; l++) {
            if (apcEvent.hasOwnProperty(addProps[l])) {
                aggObj[generalKey][specificKey][addProps[l]] += apcEvent[addProps[l]]; // l === "Board", "Alight" ...
                bData = true;
            }
        }
        if (bData) {
            aggObj[generalKey][specificKey].Count += 1;
        }
    } // for "Line", "Station", "Module"
} // addEventToAggregate

/**
 *
 * @param msgObject: CTS-event
 * @param callback: standard nodejs err, reply callback to notify caller that asynch operations completed
 *
 * CTS_EVENT_ID: counter, ensures each is msgObject is stored with a unique ID
 * hset: hash of all CTS events. Stores each msgObject
 * secondary indexes enable us to extract a set of events based on start- and stop-time
 * Each index allow this for one type of "object", ie. per line, destination, train, ...
 * An index consist of eventID and timestamp.
 * We maintain the following indexes:
 *  ctsTimestamp: ALL eventIDs and their timestamps
 *  trainLog<train_no>      : - one list for each train
 *  Line<line>              : - one list of events for each line
 *  Destination<destination>: - one list for each destination
 *  berth                   : - one list for each individual berth
 *  berthtrain              : - one list for each combination of train and berth
 *  ghost                   : - list of ghost events
 *  trainjumps              : - list of trainjum events
 *
 *  Sets, storing keys. These sets contain all trainnumbers, destinations, berths that we have received data on
 *  May be useful for accessing some of the indexes above
 *  -trainLogKeys
 *  - destinationKeys
 *  - berthkeys
 *
 * Publishes:
 * - cts_ghost_train
 * - cts_special_code
 * - cts_trainno_change
 * - cts_event
 * - cts-event_missing_to
 */

Store.saveCTSEvent = function (msgObject, callback) {
    assert (msgObject.hasOwnProperty("values"), "no property msgObject.values: ");
    assert (new Date(msgObject.values.time_stamp) instanceof Date, "not timestring: msgObject.values.time_stamp");
    assert (typeof callback === "function", "callback is not function");
    assert (msgObject.values.hasOwnProperty("to_infra_berth"));

    if (!Store.isMaster()) {
        return;
    }

    const timestamp = new Date(msgObject.values.time_stamp).getTime();
    const trainNo = msgObject.values.address;

    //logMemory.info ("test memory %d", process.memoryUsage().rss);

    redisStore.incr(k.ctsCounter, function (err, eID) {
        var multi = redisStore.multi();
        if (err) {
            log.error("Store.saveCTSEvent. redis error: " + err);
        }
        else {
            multi.hset(k.ctsEvents, ctsPrefix + eID, JSON.stringify(flatten(msgObject))); //flatten(CTS_toBerthObject.Name
            multi.zadd(k.ctsTimestamp, timestamp, ctsPrefix + eID); // sorted list of all events timestamp/eventID

            /*
            kafka.topic("metro-cts").partition(0).produce([JSON.stringify(msgObject)], function (err, response) {
                if (err) {
                    log.error("saveCTSEvent. Writing to Ruter Kafka failed: " + err);
                }
            });
            */

            if (msgObject.values.event === "ghost") {
                //pub.publish("cts_ghost_train", JSON.stringify(msgObject));
                multi.zadd(k.ghost, timestamp, ctsPrefix + eID); // keep sorted set of timestamp/eventIDs per ghost train
            }
            else if (msgObject.values.event === "trnochg") {
                //pub.publish("cts_trainno_change", JSON.stringify(msgObject));
                multi.zadd(k.trainnochange, timestamp, ctsPrefix + eID);
            }
            else if (msgObject.values.event === "special") {
                //pub.publish("cts_special_code", JSON.stringify(msgObject));
                addIndexes(timestamp, ctsPrefix + eID, msgObject, multi);
            }
            else if (msgObject.values.event === "event") { // normal event
                //pub.publish("cts_event", JSON.stringify(msgObject));
                addIndexes(timestamp, ctsPrefix + eID, msgObject, multi);
            }
            else { // not valid toBerth..
                //pub.publish("cts_event_missing_to", JSON.stringify(msgObject));
            }

            multi.exec(function (err, data) {
                if (err)
                    log.error("SaveCTSEvent. multi.exec Error: " + err + " data: " + data);
                callback(err, data);
            });
        }
    }); // store to Redis
}; // saveCTSEvent()

function addIndexes (timestamp, eID, msgObject, multi) {
    assert (typeof timestamp === "number");
    assert(typeof eID === "string");
    assert (typeof msgObject === "object");

    let trainNo = msgObject.values.address;

    if (!trainNo) {
        return;
    }

    multi.zadd(km(k.trainLog, trainNo), timestamp, eID); // one sorted set of timestamp/eventIDs per logical train
    multi.sadd(km(k.trainlogKeys), trainNo); // keep a set containg all logical train numbers

    if (msgObject.values.destination) {
        multi.zadd(km(k.destination, msgObject.values.destination), timestamp, eID); // one sorted set of timestamp/eventIDs per logical train
        multi.sadd(k.destinationKeys, msgObject.values.destination); // keep a set containg all destinations
    }
    if (msgObject.values.Line) {
        multi.zadd(km(k.line, msgObject.values.Line), timestamp, eID); // one sorted set of timestamp/eventIDs per logical train
    }

    if (msgObject.values.to_infra_berth && msgObject.values.to_infra_berth.Name) {
        multi.zadd(km(k.berth, msgObject.values.to_infra_berth.Name), timestamp, eID); // one sorted set of timestamp/eventIDs per logical berth
        multi.zadd(km(k.trainberth, trainNo, msgObject.values.to_infra_berth.Name), timestamp, eID); // one sorted set of timestamp/eventIDs per logical train AND berth
        multi.sadd(k.berthKeys, msgObject.values.to_infra_berth.Name); // keep a set containg all berths
    }
    if (msgObject.values.isTrainJump) {
        multi.zadd(k.trainjumps, timestamp, eID);
    }
} // addIndexes()

Store.saveAPCEvent = function (msgObject, callback) {
    assert (typeof  msgObject === "object");
    assert (msgObject.hasOwnProperty ("trains"), "no property msgObject.values");
    assert (Array.isArray(msgObject.passengers));
    assert (typeof msgObject.updateTime === "number");

    const multi = redisStore.multi();
    const apcArray = msgObject.passengers;

    for (let i=0; i < apcArray.length; i++) {

        const timestamp = apcArray[i].value.passengers.DateAndTimeUnix; // * 1000;
        const apcEvent = {
            "Alight": apcArray[i].value.passengers.TotalAlighting,
            "Board": apcArray[i].value.passengers.TotalBoarding,
            "Timestamp": timestamp,
            "Module": apcArray[i].value.passengers.OwnModuleNo,
            "Line": apcArray[i].value.passengers.LineNumber,
            "Station": apcArray[i].value.station.stationCode
        };

        for (let j=0;j<arrIntervals.length;j++) {
            addEventToAggregate (arrIntervals[j].aggObj, apcEvent, arrIntervals[j].addProps);
            arrIntervals[j].Count += 1;
        }
        log.info ("APC event: " + new Date(timestamp).toTimeString() + " Alight: " + apcEvent.Alight + " Board: " + apcEvent.Board + " Line: " + apcEvent.Line + " Station: " + apcEvent.Station);

        if (!Store.isMaster()) {
            continue;
        }

        redisStore.incr(k.apcCounter, function (err, eID) {
            if (err) {
                log.error("saveAPCEvent. Unable to increment APCCounter: " + err.msg + "eID: " + eID);
                return;
            }
            else {
                multi.hset(k.apcEvents, apcPrefix + eID, JSON.stringify(flatten(apcEvent)));

                // secondary index for all events
                multi.zadd(k.apcTimestamp, timestamp, apcPrefix + eID); // sorted list of all events timestamp/eventID according to when the event occured
                multi.zadd(k.apcReceivedTimestamp, new Date().getTime(), apcPrefix + eID); // sorted list of all events timestamp/eventID according to when we received the event
                // Note: until the APC deliver data for each station in real time, we must use the received timestamp for stream calculations
                // Currently, the APC only deliver data at end stations, so it can take very long time between an alight/board event and the time we receive the event

                // secondary indexes for each type
                multi.zadd(km(k.apcLine, apcArray[i].value.passengers.LineNumber), timestamp, apcPrefix + eID);
                multi.zadd(km(k.apcStation, apcArray[i].value.station.stationCode), timestamp, apcPrefix + eID);
                multi.zadd(km(k.apcOwnModuleNo, apcArray[i].value.passengers.OwnModuleNo), timestamp, apcPrefix + eID);

                // For all types of keys, keep sets of keys. Handy for debug and maybe handy in the future
                multi.sadd(k.apcLineKeys, apcArray[i].value.passengers.LineNumber);
                multi.sadd(k.apcStationKeys, apcArray[i].value.station.stationCode);
                multi.sadd(k.apcOwnModuleKeys, apcArray[i].value.passengers.OwnModuleNo);

                /*
                kafka.topic("metro-apc").partition(0).produce([JSON.stringify(apcArray[i])], function (err, response) {
                    if (err) {
                        let test = err;
                        log.error("saveAPCEvent. Writing to Ruter Kafka failed: " + err);
                    }
                });
                */

                multi.exec(function (err, data) {
                    if (err)
                        log.error("SaveAPCEvent. multi.exec Error: " + err + " data: " + data);
                    callback(err, data);
                });
            }
        }); // incr
    } // for-loop

    // Notify all fixed interval streams that data has been added
    for (let j=0;j<arrIntervals.length;j++) {
        arrIntervals[j].dataAdded();
    }
}; // saveAPCEvent()


// experimental - not used
Store.scanStore = function (from,to, callbackfn) {
    let count = 0;
    var stream = redisStore.zscanStream(km(k.ctsTimestamp), { match: "*", count: 100} );
    var keys = [];
    stream.on('data', function (resultKeys) {
        // `resultKeys` is an array of strings representing key names
        //for (var i = 0; i < resultKeys.length; i++) {
        //    keys.push(resultKeys[i]);
        //}
        console.log("Keys are: " + resultKeys.toString());
        count += 1;
        console.log("Length: " + resultKeys.length);
        console.log("Count: " + count);
    });
    stream.on('end', function () {
        //console.log('done with the keys: ', keys);
        console.log("Final count: " + count);
    });
    /*
    redisStore.zrangebyscore(keyMgr(opStore.cts_timestamp), startTime, stopTime, function (err, reply) {
        if (err) {
            log.warn("playAllTrains - Redis count error: " + err);
            return;
        }
        eventIDs = reply;
        //console.log ("playAllTrains - eventIDs: " + eventIDs.toString());
        if (!eventIDs) {
            log.warn("playAllTrains - unable to retrieve cts events");
            return;
        }
        redisStore.hmget(keyMgr(opStore.cts), eventIDs, function (err, ctsEvents) {
            let tmpSocket = null;
            let trainObj = {};
            let prop = null;
            let i = 0;
            if (err) {
                log.warn("playAllTrains - Redis could not retrieve historical data: " + err);
                return;
            }
            if (!Array.isArray(ctsEvents)) {
                log.warn("playAllTrains - Redis request did not return valid response. Expected array: " + ctsEvents);
                return;
            }

            tmpSocket = io.sockets.connected[toSocketID];
            if (!tmpSocket) {
                log.error("playAllTrains - Internal communications error. Connection lost: " + toSocketID);
                return;
            }
            tmpSocket.historyList = [];
            for (i = 0; i < ctsEvents.length; i++) {
                flatmsgObject = JSON.parse(ctsEvents[i]);
                msgObject = unflatten(flatmsgObject);
                tmpSocket.historyList.push(msgObject);
            }
            log.info("playAllTrains. tmpSocket.historyList.length: " + tmpSocket.historyList.length);
            playBackEvent(toSocketID, "cts");
        }); // redis hmget-callback
    }); // redis zrange-callback
    */
}; // scanStore()

Store.redisFreeOldData = setInterval(function () {
    if (!Store.isMaster()) {
        return;
    }
    redisStore.zcount(k.ctsTimestamp, "-inf", "+inf", function (err, count) {
        if (err) {
            log.eror("Store.redisFreeOldData. Redis count error: " + err);
        }
        else if (count > maxCTS) {
            // get all events from the oldes (starting at index 0) and up to count-maxCTS
            redisStore.zrange(k.ctsTimestamp, 0, count - maxCTS, function (err, ctsEventsToDelete) { // get all events to delete
                var i = 0;
                var multi = redisStore.multi();

                //console.log ("ctsEventsToDelete: " + ctsEventsToDelete);
                multi.hdel(k.ctsEvents, ctsEventsToDelete);
                multi.zrem(k.ctsTimestamp, ctsEventsToDelete);
                multi.smembers(k.trainlogKeys);
                multi.exec(function (err, replies) {
                    var trainKeys = [];
                    var innerMulti = redisStore.multi();
                    if (err) {
                        log.error("Store.redisFreeOldData. Unable to delete: " + err);
                        return;
                    }
                    trainKeys = replies[2];
                    for (i = 0; i < trainKeys.length; i++) {
                        innerMulti.zrem(trainKeys[i], ctsEventsToDelete); // ... and remove the events we want to
                    }
                    innerMulti.exec(function (err, replies) {
                        if (err) {
                            log.error("Unable to delete: " + err);
                            return;
                        }
                        // todo: iterate through replies and remove any smembers with no events?
                        //console.log (replies.toString());
                    }); // innerMulti.exec()
                }); // outer multi.exec()
            }); // zrange
        } // count > maxCTS?
    }); // zcount
}, 1000 * 10); // check every 10th second

Store.testSubscribe = function () {
    //assert.ok(typeof callback === "function", "Store.testSubscribe invalid callback");
    // just for testing and verifying connection opStore connection
    // if you'd like to select database 3, instead of 0 (default), call
    // client.select(3, function() { /* ... */ });
    redisSubscriberClient.subscribe("testsubscription");
    //opstore.subscribe("cts");
    //return redisSubscriberClient.subscribe(topic);
}; // testSubscribe()

Store.flushAll = function (callback) {
    assert.ok(typeof callback === "function", "Store.flushAll invalid callback: " + callback);
    redisStore.flushall(function (err, succeeded) {
        callback(err, succeeded);
        //socket.emit("chat message", "Redis says: " + err + " " + succeeded); // will be true if successfull
    });
}; //flushAll()

let bMaster = false;

Store.isMaster = function () {
    return bMaster;
};
Store.setMaster = function (bState) {
    assert.ok(typeof bState === "boolean");
    bMaster = bState;
};

Store.subscribe = function (topic) {
    assert.ok(typeof topic === "string");
    return redisSubscriberClient.subscribe(topic);
}; // subscribe()

redisSubscriberClient.on("Error", function (err) {
    log.error("redisSubscriberClient.on-Error: " + err);
});

redisSubscriberClient.on("subscribe", function (channel, message ) {
    //io.emit("chat message", "succesful subscribe to Redis " + channel + "  " + message);
    log.info("succesful subscribe to Redis: " + channel + " " + count);
});
pub.on("subscribe", function (channel, message ) {
    //io.emit("chat message", "succesful subscribe to Redis " + channel + "  " + message);
    log.info("succesful subscribe to Redis: " + channel + " " + count);
});

Store.on = function (topic, callbackfn) {
    console.log("Store.on. topic: " + topic);
    redisSubscriberClient.on (topic, callbackfn);
    //return redisSubscriberClient.on (event, callbackfn);
};

Store.unsubscribe = function () {
    redisSubscriberClient.unsubscribe();
    pub.unsubscribe();
};
Store.end = function () {
    redisStore.end();
    redisSubscriberClient.end();
    pub.end();
};
Store.getStoreInfo = function () {
    return redisStore.serverInfo;
}; // getStoreInfo()

Store.getStoreCommands = function () {
    return redisStore.getBuiltinCommands().toString();
}; // getStoreCommands

// Key Management
//
let k = {};  // short for "Key Store"
k.base = "om"; // short for "OsloMetro"
k.users = km(k.base,"users"); //list
k.status = km(k.base,"status"); //String, :userName

const ctsPrefix = "cts";
k.ctsCounter = km(k.base, ctsPrefix, "COUNTER");
k.ctsEvents = km(k.base, ctsPrefix);  // hash of all valid cts events
k.ctsTimestamp = km(k.base, ctsPrefix, "timestamp"); // sorted list of cts-events
k.berth = km(k.base, ctsPrefix, "berth");
k.trainberth = km(k.base, ctsPrefix, "trainlognr", "berth");
k.line = km(k.base, ctsPrefix, "line");
k.destination = km(k.base, ctsPrefix, "destination");

k.trainnochange = km(k.base, ctsPrefix, "trnochg");

k.trainLog = km(k.base, ctsPrefix,"trainlognr"); // sorted lists, one for each logical train number containing score timestamp, member ctsEventID
k.trainlogKeys = km(k.base, ctsPrefix,"key","trainlognr"); // set of strings, each a logical train number
k.trainjumps = km(k.base, ctsPrefix, "trainjump");

k.destinationKeys = km(k.base, ctsPrefix, "key", "destination");
k.berthKeys = km(k.base, ctsPrefix, "key", "berth");

const apcPrefix = "apc";
k.apcCounter = km(k.base, apcPrefix, "COUNTER");
k.apcAggregateCounter = km(k.base, apcPrefix, "AGG_COUNTER");
k.apcEvents = km(k.base, apcPrefix, "event");
k.apcAggEvents = km(k.base, apcPrefix, "agg");
k.apcTimestamp = km(k.base, apcPrefix, "ts"); // sorted list of cts-events
k.apcReceivedTimestamp = km(k.base, apcPrefix, "rec", "ts");
k.apcAggTimestamp = km(k.base, apcPrefix, "agg", "ts");
k.apcLine = km(k.base, apcPrefix, "line");
k.apcStation = km(k.base, apcPrefix, "station");
k.apcOwnModuleNo = km(k.base, apcPrefix,"module"); // sorted lists, one for each physical 3-car-set number containing score timestamp, member ctsEventID
k.apcLineKeys = km(k.base, apcPrefix, "key","line");
k.apcStationKeys = km(k.base, apcPrefix, "key","station");
k.apcOwnModuleKeys = km(k.base, apcPrefix,"key", "ownmoduleno"); // set of strings, each a physical 3-car-set number

function km() {  // km - short for "Key Manager"
    return Array.prototype.slice.call(arguments).join(":");
}

Store.k = k;
Store.km = km;

redisSubscriberClient.on("Error", function (err) {
    log.error("redisSubscriberClient.on -  Error " + err);
    //callback(err, null);
});
redisStore.on("Error", function (err) {
    log.error("redisStore.on -  Error " + err);
    //callback(err, null);
});

module.exports = Store;