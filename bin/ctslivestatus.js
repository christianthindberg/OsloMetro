/**
 * Created by christianthindberg on 04/10/2016.
 *
 * Provide information on events to clients (via www) and to users (through the commands module)
 *
 * functions:
 *  CTSRealTime.getLiveObject
 *  CTSRealTime.getBerthsReceivedObject
 *  CTSRealTime.getAllTails
 *  CTSRealTime.getGhosts
 *      function updateCTSLiveObject
 *
 *  const trainsInTraffic - generate event "trainsintraffic" with number of trains we have heard from during last hour
 *  const removeTrains - generate event "removetrain" if no signal received from train in 60 mins
 *
 *  --> ctshistory: CTSRealTime.parseAndSendCTShistory = function (room, channel, msgObject)

        redisStore.publish("cts_ghost_train", eID);
        redisStore.publish("cts_special_code", eID);
        redisStore.publish("cts_trainno_change", eID);
        redisStore.publish("cts_event", eID);
        redisStore.publish("cts_event_invalid", eID);

 *
 *
 *
 */



"use strict";

const helpers = require("./helpers");
const assert = require("assert");
const logger = require("./logger");
const log = logger().getLogger("ctslivestatus");

let io = null;

let ctsLiveObject = {}; // train berth, ... live data from cts
let ctsGhosts = {}; // some times we receive "noise" or incorrect data from the signalling system, referred to as "ghost trains"
let ctsOKObject = {}; // for debug all berths that we have managed to match agains list from InfrastrukturEnheten


let CTSLiveStatus = {
    version: 1.0
};

CTSLiveStatus.updateCTSLiveObject = function (msgObject) {
    let trainNo = null;
    assert (typeof msgObject === "object");

    trainNo = msgObject.values.address;

    if (!ctsLiveObject.hasOwnProperty([trainNo])) { // first time we receive data for this trainNo, or it was previously deleted due to train number change
        //console.log("CTS-trainnumber_first_time: " + msgObject.values.address);
        msgObject.values.firstTime = true;
        ctsLiveObject[trainNo] = [];
    }
    // insert this berth event first in the list of events for this train
    ctsLiveObject[trainNo].unshift(msgObject);

    // do not allow the berth event list to grow forever
    while (ctsLiveObject[trainNo].length > 200) {
        ctsLiveObject[trainNo].pop();
    }
}; // updateCTSLiveObject()

CTSLiveStatus.getLiveObject = function (train) {

    if (!ctsLiveObject) {
        return null;
    }
    if (train) {  // asking for specific train?
        return ctsLiveObject.hasOwnProperty(train) ? ctsLiveObject[train] : null;
    }
    // return the full set of Live Data
    return ctsLiveObject;
}; // getLiveObject()


CTSLiveStatus.getBerthsReceivedObject = function () {
    return ctsOKObject;
}; // getBerthsReceivedObject()

CTSLiveStatus.getTail = function (trainNo, noOfBerths) {
    let n = 0;
    assert (typeof trainNo === "string");
    assert(typeof noOfBerths === "number");

    // Server lacking data?
    if (!ctsLiveObject[trainNo]) {
        log.error("getTail. No Live data for trainNo: " + trainNo);
        return null;
    }
    n = Math.min(ctsLiveObject[trainNo].length, noOfBerths);
    return ctsLiveObject[trainNo].slice(0, n);
}; // getTail()

CTSLiveStatus.getAllTails = function (maxBerths) {
    let train=null;
    let trainsToSend = [];

    assert (typeof maxBerths === "number");

    // Server lacking data?
    if (!ctsLiveObject) {
        return null;
    }

    for (train in ctsLiveObject) {
        let n = Math.min(ctsLiveObject[train].length, maxBerths);
        // trainsToSend is an array of arrays, trainsToSend[i] contains an array of 0..n passings for one train
        trainsToSend.push(ctsLiveObject[train].slice(0, n));
    }
    // sort array so that the train with the oldest passing is first
    // this will allow the client to draw the tails in order, with the newest passings "on top" visible for the user
    trainsToSend.sort(function (a, b) {
        return Date.parse(a[0].values.time_stamp) - Date.parse(b[0].values.time_stamp);
    });
}; // getAllTails()

CTSLiveStatus.getGhosts = function () {
    // return the full set of Live Data
    return ctsGhosts;
}; // getCTSLiveObject()

const trainsInTraffic = setInterval(function () {
    io.to("realtime").emit("trainsintraffic", countTrainsInTraffic());
}, 1000*20);

function countTrainsInTraffic() {
    let count = 0; let timeTrain = 0, timeDiff = 0;
    let train = null;
    const timeNow = Date.now();
    for (train in ctsLiveObject) {
        if (!ctsLiveObject[train][0].hasOwnProperty("values")) {
            continue;
        }
        timeTrain = Date.parse(ctsLiveObject[train][0].values.time_stamp);
        timeDiff = timeNow - timeTrain;
        //console.log("timeDiff: " + timeDiff);
        if (timeDiff > 60 * 60 * 1000) {
            //log.info("timeDiff: " + timeDiff);
            continue; // Inactive train, do not count
        }
        count += 1;
    }
    return count;
} // countTrainsInTraffic()

// trains change their number. Since CTS do not give us these changes we will just assume that
// trains that have not had any movement for some time are no longer valid and we alert the clients
const removeTrains = setInterval(function () {
    let train;
    for (train in ctsLiveObject) {
        if (Date.now() - Date.parse(ctsLiveObject[train][0].values.time_stamp) > 1 * 60 * 60 * 1000) { // no news from train in 1 hr or more?
            io.to("realtime").emit("removetrain", train);
            delete ctsLiveObject[train];
        }
    }
}, 60 * 60 * 1000); // check every hour




// RECEIVE and SEND functions
// parsePassengerData, parseSumPerLine, parseSumPerStation, etc

// todo: not use ctsLive etc, not save to redis, ...
CTSLiveStatus.parseAndSendCTShistory = function (room, channel, msgObject) {
  return;
}; // parseandsendCTShistory ()

module.exports = function (pio) {
    if (pio) {
        io = pio;
    }
    return CTSLiveStatus;
}