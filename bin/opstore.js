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
const assert = require("assert");
const logger = require("./logger");
const log = logger().getLogger("opstore");
let KafkaRest = require("kafka-rest");
let kafka = new KafkaRest({"url": "http://ec2-52-211-70-204.eu-west-1.compute.amazonaws.com:8082"});
//const logMemory = logger().getLogger("memory-usage");


kafka.topics.list(function (err, topics) {
    if (err) {
        log.error ("kafka.topics.list. Unable to list topics: " + err);
        return;
    }
    for (let i=0; i < topics.length; i++) {
        console.log(topics[i].toString());
    }
});

// max number of events to store
let maxCTS = os.platform() === "darwin" ? 5000 : 300000;
// some vars to keep track of Redis

// used for storing data
const redisStore = os.platform() === "darwin" ? new Redis() : new Redis(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");
// used to receive subscription notifications
const redisSubscriberClient = os.platform() === "darwin" ? new Redis() : new Redis(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");
// used for testing
const pub = os.platform() === "darwin" ? new Redis() : new Redis(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");
console.log ("Redis connect: " + JSON.stringify(redisStore));

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
    redisStore.get("CTS_EVENT_ID", callback);
}; // getLastCTSEventID()

Store.countCTSEvents = function (callback) {
    assert.ok(typeof callback === "function");

    redisStore.zcount(km(k.ctsTimestamp), "-inf", "+inf", function (err, count) {
       callback (err, count);
    });
}; // countCTSEvents()

Store.getCTSEventByID = function (eventID, callback) {
    assert.ok(typeof callback === "function");
    assert.ok(typeof  eventID === "number");

    redisStore.hget(km(k.ctsEvents), eventID, function (err, result) {
        const flatmsgObject = JSON.parse(result);
        const msgObject = unflatten(flatmsgObject);
        callback (err, msgObject);
    });
}; // getCTSEventByID()


Store.getTrainNumbersLogical = function (callback) {
    assert.ok(typeof callback === "function");
    redisStore.smembers(km(k.trainlogKeys), callback);
}; // getTrainNumbersLogical()

Store.getFirstAndLastCTSEvent = function (callback) {
    assert.ok(typeof callback === "function");

    const multi = redisStore.multi();

    multi.zrange(km(k.ctsTimestamp), 0, 0, "withscores");
    multi.zrange(km(k.ctsTimestamp), -1, -1, "withscores");
    multi.exec(function (err, result) {
        callback(err,result);
    });
}; // getFirstAndLastCTSEvent()


// Beware of nesting...
/**
 *
 * getACPEventAggregate -- called at regular interval, f.ex every 10th second, and calclulate the aggregate (i.e. total number of boarding, alighting)
 *                          over a given period (ex. 20 minutes)
 *                          Since we are called regularly there is no need to recalculate the full 20 minute periode. We only calculate the newest 10 second period and the 10 second period
 *                          that is now too old to be part of the 20 min aggregate.
 *
 *                          Thus we implement a sliding time window, where we add the newest 10 seconds of data and remove the oldest 10 seconds
 *
 * @param prevStop:         when did we stop last time we aggregated? this will typically be 10 seconds ago
 * @param fromTimestamp     the starting point. This will typically be 20 minutes earlier than the curent time
 * @param toTimestamp       typically equal to current time
 * @param timeDelta         how much are we moving the sliding time windows forward? Typically 10 seconds
 * @param aggObj            The object containing the result of aggregateing all boardings over the sliding window time frame
 * @param aggMinusObj       Object used to store the data we remove from the time window
 * @param callback          Function for returning the results. Note: calls to Redis are asynch, so we typically need to do a bit of nesting. todo: consider using promises
 *
 *
 */
Store.getAPCEventAggregate = function (prevStop, fromTimestamp, toTimestamp, timeDelta, aggObj, aggMinusObj, callback) {
    assert (typeof fromTimestamp === "number");
    assert (typeof toTimestamp === "number");
    assert (typeof callback === "function");

    let eventsArr = [];
    let testRange = toTimestamp - fromTimestamp;
    let testTime = new Date(testRange);
    const multi = redisStore.multi();

    multi.zrangebyscore(km(k.apcTimestamp), fromTimestamp-timeDelta, fromTimestamp);
    multi.zrangebyscore(km(k.apcTimestamp), prevStop, toTimestamp);
    multi.exec (function (err, reply) {
        if (err) {
            log.error("getACPEvents. Error retrieving apcKeys: " + err.message);
            return callback (err, aggObj);
        }
        else {
            const minusEvents = reply[0][1];
            const addEvents = reply[1][1];
            if (addEvents.length === 0) {
                callback (err, aggObj);
            }
            else {
                const multi = redisStore.multi();
                if (minusEvents.length > 0) {
                    multi.hmget(km(k.apcEvents), minusEvents);
                }
                multi.hmget(km(k.apcEvents), addEvents);
                multi.exec(function (err, reply) {
                    if (err) {
                        log.error ("getAPCEventAggregate. Error retrieving apcEvents: " + err.message);
                        callback (err, null);
                    }
                    else {
                        const arrMinusHashes = minusEvents.length > 0 ? reply [0][1]: [];
                        const arrHashes = minusEvents.length > 0 ? reply[1][1] : reply [0][1];

                        aggregateEvents(aggObj, arrHashes);
                        aggregateEvents(aggMinusObj, arrMinusHashes);
                        // subtract events...
                        for (let prop in aggMinusObj) { // "Line", "Station", ...
                            if (aggMinusObj.hasOwnProperty(prop) && aggObj.hasOwnProperty(prop)) {
                                let specificMinusObj = aggMinusObj[prop];
                                let specificAggObj = aggObj[prop];
                                for (let p in specificMinusObj) { //"1", "2", "KOL", ...
                                    if (specificMinusObj.hasOwnProperty(p) && specificAggObj.hasOwnProperty(p)) {
                                        specificAggObj[p]["Board"] -= specificMinusObj[p]["Board"];
                                        specificAggObj[p]["Alight"] -= specificMinusObj[p]["Alight"];
                                        specificAggObj[p]["Count"] -= specificMinusObj[p]["Count"];
                                    }
                                }
                            }
                        }
                        callback (err, aggObj);
                    } // inner inner else :-)
                }); // hmget
            } // inner else
        } // outer else
    }); // zrangebyscore
}; // getAPCEventAggregate()

function aggregateEvents (aggObj, arrHashes) {
    let i= 0, j=0;

    // iterate the events list
    for (i = 0; i < arrHashes.length; i++) {
        let apcEvent = unflatten(JSON.parse(arrHashes[i]));

        if (!apcEvent.hasOwnProperty("Line") || !apcEvent.hasOwnProperty("Station") || !apcEvent.hasOwnProperty("Module")) {
            log.error ("getAPCEventAggregate. retrieved invalid apcEvent: " + JSON.stringify(apcEvent));
            return callback (new Error("getAPCEventAggregate. retrieved invalid apcEvent: " + JSON.stringify(apcEvent)), null);
        }

        // iterate the keys of the aggregator object - Line, Station, Module
        for (j=0; j<Object.keys(aggObj).length; j++) {
            const generalKey = Object.keys(aggObj)[j];     // generalKey === "Line" || "Station" || "Module"
            const specificKey = apcEvent[generalKey];    // ex 3, KOL, 30023

            if (!aggObj[generalKey].hasOwnProperty(specificKey)) { // f.ex aggObj.Station.KOL
                aggObj[generalKey][specificKey] = { "Alight": 0, "Board": 0, "Count": 0 };
            }
            // add the current event to the aggregate
            aggObj[generalKey][specificKey]["Board"] += apcEvent.Board;
            aggObj[generalKey][specificKey]["Alight"] += apcEvent.Alight;
            aggObj[generalKey][specificKey]["Count"] += 1;
        } // for "Line", "Station", "Module"
    } // for events list
    return aggObj;
} // aggregateEvents()

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

    redisStore.incr(ctsCounter, function (err, eID) {
        var multi = redisStore.multi();
        if (err) {
            log.error("Store.saveCTSEvent. redis error: " + err);
        }
        else {
            multi.hset(km(k.ctsEvents), ctsPrefix + eID, JSON.stringify(flatten(msgObject))); //flatten(CTS_toBerthObject.Name
            multi.zadd(km(k.ctsTimestamp), timestamp, ctsPrefix + eID); // sorted list of all events timestamp/eventID

            kafka.topic("metro-cts").partition(0).produce([JSON.stringify(msgObject)], function (err, response) {
                if (err) {
                    log.error("saveCTSEvent. Writing to Ruter Kafka failed: " + err);
                }
            });

            if (msgObject.values.event === "ghost") {
                //pub.publish("cts_ghost_train", JSON.stringify(msgObject));
                multi.zadd(km(k.ghost), timestamp, ctsPrefix + eID); // keep sorted set of timestamp/eventIDs per ghost train
            }
            else if (msgObject.values.event === "trnochg") {
                //pub.publish("cts_trainno_change", JSON.stringify(msgObject));
                multi.zadd(km(k.trainnochange), timestamp, ctsPrefix + eID);
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
        multi.sadd(km(k.destinationKeys), msgObject.values.destination); // keep a set containg all destinations
    }
    if (msgObject.values.Line) {
        multi.zadd(km(k.line, msgObject.values.Line), timestamp, eID); // one sorted set of timestamp/eventIDs per logical train
    }

    if (msgObject.values.to_infra_berth && msgObject.values.to_infra_berth.Name) {
        multi.zadd(km(k.berth, msgObject.values.to_infra_berth.Name), timestamp, eID); // one sorted set of timestamp/eventIDs per logical berth
        multi.zadd(km(k.trainberth, trainNo, msgObject.values.to_infra_berth.Name), timestamp, eID); // one sorted set of timestamp/eventIDs per logical train AND berth
        multi.sadd(km(k.berthKeys), msgObject.values.to_infra_berth.Name); // keep a set containg all berths
    }
    if (msgObject.values.isTrainJump) {
        multi.zadd(km(k.trainjumps), timestamp, eID);
    }
} // addIndexes()

Store.saveAPCEvent = function (msgObject, callback) {
    assert (typeof  msgObject === "object");
    assert (msgObject.hasOwnProperty ("trains"), "no property msgObject.values");
    assert (Array.isArray(msgObject.passengers));
    assert (typeof msgObject.updateTime === "number");

    const multi = redisStore.multi();
    const apcArray = msgObject.passengers;

    if (!Store.isMaster()) {
        return;
    }

    for (let i=0; i < apcArray.length; i++) {
        redisStore.incr(APCcounter, function (err, eID) {
            if (err) {
                log.error("dkdkdkdk"); // todo: fix
                return;
            }
            else {
                const timestamp = apcArray[i].value.passengers.DateAndTimeUnix; // * 1000;
                const alightboard = {
                    "Alight": apcArray[i].value.passengers.TotalAlighting,
                    "Board": apcArray[i].value.passengers.TotalBoarding,
                    "Timestamp": timestamp,
                    "Module": apcArray[i].value.passengers.OwnModuleNo,
                    "Line": apcArray[i].value.passengers.LineNumber,
                    "Station": apcArray[i].value.station.stationCode
                };

                console.log("APC event: " + new Date(timestamp).toTimeString());

                multi.hset(km(k.apcEvents), apcPrefix + eID, JSON.stringify(flatten(alightboard)));

                // secondary index for all events
                multi.zadd(km(k.apcTimestamp), timestamp, apcPrefix + eID); // sorted list of all events timestamp/eventID

                // secondary indexes for each type
                multi.zadd(km(k.apcLine, apcArray[i].value.passengers.LineNumber), timestamp, apcPrefix + eID);
                multi.zadd(km(k.apcStation, apcArray[i].value.station.stationCode), timestamp, apcPrefix + eID);
                multi.zadd(km(k.apcOwnModuleNo, apcArray[i].value.passengers.OwnModuleNo), timestamp, apcPrefix + eID);

                // For all types of keys, keep sets of keys. Handy for debug and maybe handy in the future
                multi.sadd(km(k.apcLineKeys), apcArray[i].value.passengers.LineNumber);
                multi.sadd(km(k.apcStationKeys), apcArray[i].value.station.stationCode);
                multi.sadd(km(k.apcOwnModuleKeys), apcArray[i].value.passengers.OwnModuleNo);

                kafka.topic("metro-apc").partition(0).produce([JSON.stringify(apcArray[i])], function (err, response) {
                    if (err) {
                        log.error("saveAPCEvent. Writing to Ruter Kafka failed: " + err);
                    }
                });

                multi.exec(function (err, data) {
                    if (err)
                        log.error("SaveAPCEvent. multi.exec Error: " + err + " data: " + data);
                    callback(err, data);
                });
            }
        }); // incr
    } // for-loop
}; // saveAPCEvent()



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
    redisStore.zcount(km(k.ctsTimestamp), "-inf", "+inf", function (err, count) {
        if (err) {
            log.eror("Store.redisFreeOldData. Redis count error: " + err);
        }
        else if (count > maxCTS) {
            // get all events from the oldes (starting at index 0) and up to count-maxCTS
            redisStore.zrange(km(k.ctsTimestamp), 0, count - maxCTS, function (err, ctsEventsToDelete) { // get all events to delete
                var i = 0;
                var multi = redisStore.multi();

                //console.log ("ctsEventsToDelete: " + ctsEventsToDelete);
                multi.hdel(km(k.ctsEvents), ctsEventsToDelete);
                multi.zrem(km(k.ctsTimestamp), ctsEventsToDelete);
                multi.smembers(km(k.trainlogKeys));
                multi.exec(function (err, replies) {
                    var trainKeys = [];
                    if (err) {
                        log.error("Store.redisFreeOldData. Unable to delete: " + err + " Reply: " + reply);
                        return;
                    }
                    trainKeys = replies[2];
                    for (i = 0; i < trainKeys.length; i++) {
                        multi.zrem(trainKeys[i], ctsEventsToDelete); // ... and remove the events we want to
                    }
                    multi.exec(function (err, replies) {
                        if (err) {
                            log.error("Unable to delete: " + err + " Reply: " + reply);
                            return;
                        }
                        // todo: iterate through replies and remove any smembers with no events?
                        //console.log (replies.toString());
                    });
                });
            }); // zrange
        } // count > maxCTS
    }); // zcount
}, 1000 * 3); // check every 3rd second

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
/*
Store.on("flushall", function(msg) {
    console.log("success: " + msg);
});

Store.on("err_flushall", function(msg) {
   console.log("error: " + msg);
});
*/
//Store.on = eventEmitter.on;

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
/*
Store.publish = function (topic, data) {
    assert(typeof topic === "string");
    assert(data);
    pub.publish (topic, data);
}; // publish()
*/

Store.on = function (topic, callbackfn) {
    console.log("Store.on. topic: " + topic);
    redisSubscriberClient.on (topic, callbackfn);
    //return redisSubscriberClient.on (event, callbackfn);
};

//pub.on("subscribe")

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

/*
redisSubscriberClient.on("error", function (err) {
    console.log("redisSubscriberClient.on(error). Error: " + err);
});
redisStore.on("error", function (err) {
    console.log("redisStore.on(error). Error: " + err);
});
*/
// Key Management
//
let k = {};  // short for "Key Store"
k.base = "om"; // short for "OsloMetro"
k.users = km(k.base,'users'); //list
k.status = km(k.base,'status'); //String, :userName

const ctsCounter = "CTS_EVENT_ID";
const ctsPrefix = "cts";

k.ctsEvents = km(k.base, "cts");  // hash of all valid cts events
k.ctsTimestamp = km(k.base, "cts", "timestamp"); // sorted list of cts-events
k.berth = km(k.base, "cts", "berth");
k.trainberth = km(k.base, "cts", "trainlognr", "berth");
k.line = km(k.base, "cts", "line");
k.destination = km(k.base, "cts", "destination");

k.trainnochange = km(k.base, "cts", "trnochg");

k.trainLog = km(k.base, "cts","trainlognr"); // sorted lists, one for each logical train number containing score timestamp, member ctsEventID
k.trainlogKeys = km(k.base, "cts","key","trainlognr"); // set of strings, each a logical train number
k.trainjumps = km(k.base, "cts", "trainjump");

k.destinationKeys = km(k.base, "cts", "key", "destination");
k.berthKeys = km(k.base, "cts", "key", "berth");

const APCcounter = "APC_EVENT_ID";
const apcPrefix = "apc";
k.apcEvents = km(k.base, "apc");
k.apcTimestamp = km(k.base, "apc", "timestamp"); // sorted list of cts-events
k.apcLine = km(k.base, "apc", "line");
k.apcStation = km(k.base, "apc", "station");
k.apcOwnModuleNo = km(k.base, "apc","module"); // sorted lists, one for each physical 3-car-set number containing score timestamp, member ctsEventID
k.apcLineKeys = km(k.base, "apc", "key","line");
k.apcStationKeys = km(k.base, "apc", "key","station");
k.apcOwnModuleKeys = km(k.base, "apc","key", "ownmoduleno"); // set of strings, each a physical 3-car-set number

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