/**
 * Created by christianthindberg on 13/09/16.
 */
"use strict";

const redis = require("redis");
require("redis-scanstreams")(redis);
const os = require("os");
const toArray = require("stream-to-array");
const flatten = require("flat");
const unflatten = require("flat").unflatten;

// max number of events to store
let maxCTS = os.platform() === "darwin" ? 5000 : 300000;
// some vars to keep track of Redis

// used for storing data
const redisStore = os.platform() === "darwin" ? redis.createClient() : redis.createClient(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");

// used to receive subscription notifications
const redisSubscriberClient = os.platform() === "darwin" ? redis.createClient() : redis.createClient(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");

// used for testing
const pub = os.platform() === "darwin" ? redis.createClient() : redis.createClient(6379, "oslometro-redis-001.ezuesa.0001.euw1.cache.amazonaws.com");


let Store = {
    version:1.0
};

Store.saveCTSEvent = function fNsaveCTSEvent (msgObject, callback) {
    if (isMaster()) {
        redisStore.incr('CTS_EVENT_ID', function (err, eID) {
            var multi = redisStore.multi();
            if (err) {
                console.log("redis error: " + err);
            }
            else {
                multi.hset(keyMgr(opStore.cts), eID, JSON.stringify(flatten(msgObject))); //flatten(CTS_toBerthObject.Name
                // parameters are KEY, SCORE, MEMBER (or value)
                multi.zadd(keyMgr(opStore.cts_timestamp), timestamp, eID); //JSON.stringify(msgObject), redis.print); // new Date(msgObject.values.time_stamp).getTime()  new Date(msgObject.values.time_stamp).getTime()
                multi.zadd(keyMgr(opStore.cts_logical_nr, trainNo), timestamp, eID);
                multi.sadd(keyMgr(opStore.cts_logical_nr_keys), keyMgr(opStore.cts_logical_nr, trainNo)); // keep a set containg all logical train numbers
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
    if (!isMaster()) {
        return;
    }
    redisStore.zcount(keyMgr(opStore.cts_timestamp), "-inf", "+inf", function (err, count) {
        if (err) {
            console.log("Redis count error: " + err);
        }
        else if (count > maxCTS) {
            // get all events from the oldes (starting at index 0) and up to count-maxCTS
            redisStore.zrange(keyMgr(opStore.cts_timestamp), 0, count - maxCTS, function (err, ctsEventsToDelete) { // get all events to delete
                var i = 0;
                var multi = redisStore.multi();

                //console.log ("ctsEventsToDelete: " + ctsEventsToDelete);
                multi.hdel(keyMgr(opStore.cts), ctsEventsToDelete);
                multi.zrem(keyMgr(opStore.cts_timestamp), ctsEventsToDelete);
                multi.smembers(keyMgr(opStore.cts_logical_nr_keys));
                multi.exec(function (err, replies) {
                    var trainKeys = [];
                    if (err) {
                        console.error("Unable to delete: " + err + " Reply: " + reply);
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
                        //console.log (replies.toString());
                    });
                });
            }); // zrange
        } // count > maxCTS
    }); // zcount
}, 1000 * 3); // check every 3rd second

Store.testSubscribe = function (callback) {
    // just for testing and verifying connection opStore connection
    // if you'd like to select database 3, instead of 0 (default), call
    // client.select(3, function() { /* ... */ });
    redisSubscriberClient.subscribe("kinesisStationsChannel");
    redisSubscriberClient.subscribe("InfrastructureStationsChannel");
    redisSubscriberClient.on("error", function (err) {
        console.log("Error " + err);
        if (callback && typeof callback === "function") {
            callback(err);
        }
    });
}; // testSubscribe()

Store.flushAll = function (callback) {
    redisStore.flushall(function (err, succeeded) {
        if (callback && typeof callback === "function") {
            callback(err, succeeded);
        }
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
    bMaster = bState;
};
Store.subscribe = function (topic) {
    return redisSubscriberClient.subscribe(topic);
};

Store.on = function (event, callbackfn) {
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
    return redisStore.server_info;
}; // getStoreInfo()

let keyStore = {};
keyStore.base = "om"; // short for "OsloMetro"
keyStore.users = keyMgr(keyStore.base,'users'); //list
keyStore.status = keyMgr(keyStore.base,'status'); //String, :userName
keyStore.cts = keyMgr(keyStore.base, "cts");  // hash of all valid cts events
keyStore.cts_timestamp = keyMgr(keyStore.base, "cts", "timestamp"); // sorted list of cts-events
keyStore.cts_logical_nr = keyMgr(keyStore.base, "cts","logical_nr"); // sorted lists, one for each logical train number, each list containing the cts events for said logical train number
keyStore.cts_logical_nr_keys = keyMgr(keyStore.base, "cts","logical_nr","key"); // sorted lists, one for each logical train number, each list containing the cts events for said logical train number

keyStore.cts_trains_carset_nr = keyMgr(keyStore.base,'cts',"carset_nr"); //not sure how to implement this yet:-)

function keyMgr() {
    return Array.prototype.slice.call(arguments).join(":");
}
keyStore.keyMgr = keyMgr;
Store.keyStore = keyStore;

module.exports = Store;


/* To use in main file

 var
 ...
 opStore = require('./opStore.module.node.js'),
 keyMgr = opStore.keyMgr;
 ...
 client.get(keyMgr(opStore.status,userName), ...)
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
