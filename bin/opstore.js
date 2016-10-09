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

const redis = require("ioredis");
const os = require("os");
const flatten = require("flat");
const unflatten = require("flat").unflatten;
const assert = require("assert");
const logger = require("./logger");
const log = logger().getLogger("opstore");
//const logMemory = logger().getLogger("memory-usage");

// max number of events to store
let maxCTS = os.platform() === "darwin" ? 5000 : 300000;
// some vars to keep track of Redis

// used for storing data
const redisStore = os.platform() === "darwin" ? new redis() : new redis(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");
// used to receive subscription notifications
const redisSubscriberClient = os.platform() === "darwin" ? new redis() : new redis(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");
// used for testing
const pub = os.platform() === "darwin" ? new redis() : new redis(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");

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

Store.getFirstAndLastEvent = function (callback) {
    assert.ok(typeof callback === "function");

    const multi = redisStore.multi();

    multi.zrange(km(k.ctsTimestamp), 0, 0, "withscores");
    multi.zrange(km(k.ctsTimestamp), -1, -1, "withscores");
    multi.exec(function (err, result) {
        callback(err,result);
    });
}; // getFirstAndLastEvent()

Store.saveCTSEvent = function (msgObject, callback) {
    assert.ok(msgObject.hasOwnProperty("values"), "Store.saveCTSEvent - no property msgObject.values: " + JSON.stringify(msgObject, undefined,2));
    assert.ok(new Date(msgObject.values.time_stamp) instanceof Date, "Store.saveCTSEvent - not timestring msgObject.values.time_stamp");
    assert.ok(typeof callback === "function", "Store.save CTSEvent - callback is not function");

    if (Store.isMaster()) {

        const timestamp = new Date(msgObject.values.time_stamp).getTime();
        const trainNo = msgObject.values.address;
        // todo: zadd per berth and per berth/train
        // todo: zadd per train number change/berth
        // todo: zadd per line
        // todo: zadd per ghost

        //logMemory.info ("test memory %d", process.memoryUsage().rss);

        redisStore.incr('CTS_EVENT_ID', function (err, eID) {
            var multi = redisStore.multi();
            if (err) {
                console.log("Store.saveCTSEvent. redis error: " + err);
            }
            else {
                multi.hset(km(k.ctsEvents), eID, JSON.stringify(flatten(msgObject))); //flatten(CTS_toBerthObject.Name
                // parameters are KEY, SCORE, MEMBER (or value)
                multi.zadd(km(k.ctsTimestamp), timestamp, eID); // sorted list of all events timestamp/eventID
                multi.zadd(km(k.trainLog, trainNo), timestamp, eID); // one sorted set of timestamp/eventIDs per logical train
                multi.sadd(km(k.trainlogKeys), trainNo); // keep a set containg all logical train numbers
                multi.exec(function (err, data) {
                    if (err)
                        console.log("err: " + err + " data: " + data);
                    callback(err, data);
                });
            }
        }); // store to Redis
    }
}; // saveCTSEvent()

Store.redisFreeOldData = setInterval(function () {
    if (!Store.isMaster()) {
        return;
    }
    redisStore.zcount(km(k.ctsTimestamp), "-inf", "+inf", function (err, count) {
        if (err) {
            console.log("Store.redisFreeOldData. Redis count error: " + err);
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
                        console.error("Store.redisFreeOldData. Unable to delete: " + err + " Reply: " + reply);
                        return;
                    }
                    trainKeys = replies[2];
                    for (i = 0; i < trainKeys.length; i++) {
                        multi.zrem(trainKeys[i], ctsEventsToDelete); // ... and remove the events we want to
                    }
                    multi.exec(function (err, replies) {
                        if (err) {
                            console.error("Unable to delete: " + err + " Reply: " + reply);
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
};

Store.on = function (event, callbackfn) {
    console.log("Store.on. event: " + event);
    return redisSubscriberClient.on (event, callbackfn);
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

redisSubscriberClient.on("error", function (err) {
    console.log("redisSubscriberClient.on(error). Error: " + err);
});
redisStore.on("error", function (err) {
    console.log("redisStore.on(error). Error: " + err);
});

// Key Management
//
let k = {};  // short for "Key Store"
k.base = "om"; // short for "OsloMetro"
k.users = km(k.base,'users'); //list
k.status = km(k.base,'status'); //String, :userName
k.ctsEvents = km(k.base, "cts");  // hash of all valid cts events
k.ctsTimestamp = km(k.base, "cts", "timestamp"); // sorted list of cts-events

k.trainLog = km(k.base, "cts","log_nr"); // sorted lists, one for each logical train number containing score timestamp, member ctsEventID
k.trainlogKeys = km(k.base, "cts","log_nr","key"); // set of strings, each a logical train number

k.trainPhys = km(k.base, "cts","phys_nr"); // sorted lists, one for each physical 3-car-set number containing score timestamp, member ctsEventID
k.trainKeysPhys = km(k.base, "cts","phys_nr","key"); // set of strings, each a physical 3-car-set number


function km() {  // km - short for "Key Manager"
    return Array.prototype.slice.call(arguments).join(":");
}

Store.k = k;
Store.km = km;

redisSubscriberClient.on("error", function (err) {
    log.error("redisSubscriberClient.on -  Error " + err);
    //callback(err, null);
});
redisStore.on("error", function (err) {
    log.error("redisStore.on -  Error " + err);
    //callback(err, null);
});

module.exports = Store;


/* To use in main file

 var
 ...
 opStore = require('./opStore.module.node.js'),
 km = opStore.km;
 ...
 client.get(km(opStore.status,userName), ...)
 */

/* Todo: add retries ...
 var client = redis.createClient({
 retry_strategy: function (options) {
 if (options.error.code === 'ECONNREFUSED') {
 // End reconnecting on a specific error and flush all commands with a individual error
 return new Error('The server refused the connection');
 }
 if (options.total_retry_time > 1000 * 60 * 60) {
 // End reconnecting after a specific timeout and flush all commands with a individual error
 return new Error('Retry time exhausted');
 }
 if (options.times_connected > 10) {
 // End reconnecting with built in error
 return undefined;
 }
 // reconnect after
 return Math.max(options.attempt * 100, 3000);
 }
 });
 */
