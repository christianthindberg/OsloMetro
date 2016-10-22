/**
 * Created by christianthindberg on 04/10/2016.
 */
"use strict";

const opstore = require ("./opstore");
const assert = require ("assert");
const logger = require('./logger');
const log = logger().getLogger('ctshistory');
const helpers = require("./helpers");

let io = null;

let CTSHistory = {
    version: 1.0
};

CTSHistory.handleHistoryPlayback = function (socket, cmdArray) {
    let tmpSocket = null;
    let toSocketID = null;
    let trainsArray = [];
    let startTime = 0;
    let stopTime = 0;

    assert(typeof socket === "object");
    assert(Array.isArray(cmdArray));

    if (!socket.joined) {
        // We receive this message from a cmd-client. If the cmd-client is not joined to a map-client, we can not proceed
        socket.emit("help", {"history": "Clients are not joined. " + cmdDictionary.history});
        return;
    }
    toSocketID = socket.room; // if we are joined, our socket.room attribute contain the socket.id of the joined client
    tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID || !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        log.warn("handleHistoryPlayback. internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }

    if (tmpSocket.mode === "history") {
        socket.emit("Already playing back history. Cancel ongoing playback first, then issue new history command.");
        return;
    }

    if (cmdArray.length >= 2 && helpers.MyIsNumber(parseInt(cmdArray[1])))
        startTime = parseInt(cmdArray[1]);
    if (cmdArray.length >= 3 && helpers.MyIsNumber(parseInt(cmdArray[2])))
        stopTime = parseInt(cmdArray[2]);
    // Set default values for start Event and range if proper values not provided by user
    if (!startTime) { startTime = 0; }
    if (!stopTime) { stopTime = Date.now(); }

    if (cmdArray.length > 3) // contains logical train ids
        trainsArray = cmdArray.slice(3, cmdArray.length); // send the train ids as an array to playHistory
    else
        trainsArray = null; // no logical train ids given, send null value to playHistory to have all trains played back

    tmpSocket.leave(tmpSocket.room); // leaving "realtime", the client will no longer receive realtime data
    tmpSocket.room = null;
    tmpSocket.mode = "history";
    tmpSocket.bCancelledByUser = false;
    socket.to(toSocketID).emit("history start", {"from": startTime, "to": stopTime});

    if (trainsArray && Array.isArray(trainsArray)) { // only play back specific trains
        playSomeTrains (toSocketID, startTime, stopTime, trainsArray);
    }
    else {
        playAllTrains (toSocketID, startTime, stopTime);
    }
}; // handleHistoryPlayback()

const playSomeTrains = function (toSocketID, startTime, stopTime, trainsArray) {
    const multi = redisStore.multi();
    let i;

    assert (typeof toSocketID === "string");
    assert (startTime === "number");
    assert (stopTime === "number");
    assert (Array.isArray(trainsArray));

    // get eventIDs per train within given range
    for (i = 0; i < trainsArray.length; i++) {
        multi.zrangebyscore(keyMgr(opStore.cts_logical_nr, trainsArray[i]), startTime, stopTime, "limit", 0, 1000);
    }
    multi.exec(function (err, replies) {
        // replies is an array with one record per zrangebyscore call
        // each record contains the eventIDs for a given train within the range
        let index;
        let eventIDs = [];
        const tmpSocket = io.sockets.connected[toSocketID];

        if (!tmpSocket) {
            log.warn("playSomeTrains - internal error, communications ID not found");
            socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
            return;
        }

        if (err) {
            log.warn("playSomeTrains. Error retrieving history data: " + err);
            return;
        }

        // Now, get the actual cts-events (not only their ID)
        tmpSocket.historyList = [];
        for (index=0; index < replies.length; index++) {
            eventIDs = eventIDs.concat(replies[index]);
            //multi.hmget(ctsStoreKey, eventIDs);
        }
        if (eventIDs.length === 0) {
            socket.emit ("chat message", "no data found!");
            return;
        }
        eventIDs.sort(function(a, b){return a-b}); //.filter(function(e) { return e === 0 || e; })); //.map(function (e) { return parseInt(e); }));

        redisStore.hmget(keyMgr(opStore.cts), eventIDs, function (err, ctsEvents) { // get lists for all trains
            let flatmsgObject = null, msgObject = null;
            let eventCTSList = [];
            let j = 0, k = 0;
            let currentCTS = null;
            if (err) {
                log.warn("playSomeTrains - unable to retrieve hash per train: " + err);
                return;
            }
            for (j=0; j < ctsEvents.length; j++) {
                currentCTS = ctsEvents[j];
                if (!currentCTS) {
                    log.warn("playSomeTrains. Unexpected null value in event data at index: " + j);
                    continue;
                }
                flatmsgObject = JSON.parse(currentCTS);
                msgObject = unflatten(flatmsgObject);
                tmpSocket.historyList.push(msgObject);
            }
            log.info("playSomeTrains. tmpSocket.historyList.length: " + tmpSocket.historyList.length);
            playBackEvent (toSocketID, "cts"); // play back event list for all trains
        });
    }); // exec zrangebyscore get all eventIDs within range
}; // playSomeTrains()

const playAllTrains = function (toSocketID, startTime, stopTime) {
    let flatmsgObject = null, msgObject = null;
    let eventIDs = null;

    assert(typeof  toSocketID === "string");
    assert(typeof startTime === "number");
    assert(typeof stopTime === "number");

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
}; //playAllTrains()

var playbackSpeed = 4;

function playBackEvent (toSocketID, channel) {
    var currTimeStamp = 0;
    var nextTimeStamp = 0;
    var historyList = null;
    var tmpSocket = null;

    assert (typeof toSocketID === "string");
    assert (typeof channel === "string");

    tmpSocket = io.sockets.connected[toSocketID];
    if (!tmpSocket) {
        log.warn("playBackEvent. Internal communications error, invalid toSocketID " + toSocketID);
        return;
    }
    if (tmpSocket.bCancelledByUser) { // We received "cancel" from user
        tmpSocket.historyList = [];
        tmpSocket.mode = "ready";  // ready for another history playback or to switch to realtime
        tmpSocket.bCancelledByUser = false;
        io.to(toSocketID).emit("history stop", "cancelled by user. Time: " + Date.now());
        return;
    }

    if (!tmpSocket.historyList || !Array.isArray(tmpSocket.historyList)) { // tmpSocket.historyList
        log.error("playBackEvent. Internal error, historyList not found.");
        return;
    }

    if (tmpSocket.historyList.length === 0) {
        log.warn("playBackEvent -- out of range");
        return;
    }

    if (!tmpSocket.historyList[0]) {
        log.error("playback -- empty element in historyList");
        return;
    }
    // todo: make general by replacing parseAndSend with a function parameter and providing functions for currTime and nextTime below
    parseAndSendCTShistory(toSocketID, channel, tmpSocket.historyList[0]); // make version that do not update ctsLive etc

    if (tmpSocket.historyList.length === 1) { // did the last one, set states and cleanup
        //console.log("time: " + new Date().getTime());
        tmpSocket.mode = "ready";  // ready for another history playback or to switch to realtime
        tmpSocket.historyList.shift(); // free the last element
        if (tmpSocket.historyList.length !== 0) {
            log.error ("playBackEvent. history not free"); // internal error
        }
        io.to(toSocketID).emit("playBackEvent. history stop", "Finished at: " + Date.now());
        return;
    }

    if (!tmpSocket.historyList[0].values) {
        console.err("playBackEvent. Missing values (0)");
        return;
    }
    if (!tmpSocket.historyList[1].values) {
        console.err("playBackEvent. Missing values (1)");
        return;
    }
    currTimeStamp = new Date(tmpSocket.historyList[0].values.time_stamp).getTime();
    nextTimeStamp = new Date(tmpSocket.historyList[1].values.time_stamp).getTime();
    tmpSocket.historyList.shift(); // remove current element
    io.to(toSocketID).emit("timetick", currTimeStamp);

    // wait until it is time to play back the next event
    setTimeout(playBackEvent, (nextTimeStamp - currTimeStamp)/playbackSpeed, toSocketID, channel);
} // playBackEvent()

CTSHistory.handlePlaybackCancel = function (socket, cmdArray) {

    assert (typeof socket === "string");
    assert (Array.isArray(cmdArray));

    if (!socket.joined) {
        socket.emit("cancel", {"cancel": cmdDictionary.cancel});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID || !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        log.warn("handlePlaybackCancel. Internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }

    if (tmpSocket.bCancelledByUser) {
        socket.emit("chat message", "Already cancelling history playback");
        return;
    }
    if (tmpSocket.mode === "history") { // playBack is ongoing
        tmpSocket.bCancelledByUser = true; // playback() will read this state, stop playback and set mode to "ready"
        socket.emit("chat message", "Cancelling history playback...");
    }
}; // handlePlaybackCancel()

CTSHistory.handleRealtime = function (socket, cmdArray) {
    if (!socket.joined) {
        socket.emit("help", {realtime: cmdDictionary.realtime});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID|| !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }
    if (tmpSocket.room === realtime) {
        socket.emit("chat message", "Already processing realtime");
        return;
    }

    if (tmpSocket.mode === "history") { // playBack is ongoing
        socket.emit("chat message", "Cancel ongoing playback/operation first, then issue new realtime command.");
        return;
    }
    if (tmpSocket.mode !== "ready") {
        console.log("received realtime. tmp.socket.mode: " + tmpSocket.mode);
    }

    if (tmpSocket.room && tmpSocket.room !== realtime) {  // remember: tmpSocket is the socket of the map-client, not current (cmd) client
        tmpSocket.leave(tmpSocket.room);
    }

    tmpSocket.join(realtime);
    tmpSocket.room = realtime;
    tmpSocket.mode = realtime;
    socket.to(toSocketID).emit(realtime, "start");
}; // handleRealtime ()

function handleAggregateSend (socket, cmdArray) {
    let tmpSocket = null, toSocketID = null;
    let trainsArray = [];
    let startTime = 0, stopTime = 0;

    assert (typeof socket === "string");
    assert (Array.isArray(cmdArray));

    if (!socket.joined) {
        // We receive this message from a cmd-client. If the cmd-client is not joined to a map-client, we can not proceed
        socket.emit("help", {"history": "Clients are not joined. " + cmdDictionary.history});
        return;
    }
    toSocketID = socket.room; // if we are joined, our socket.room attribute contain the socket.id of the joined client
    tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID || !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        log.warn("handleAggregateSend. Internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }

    if (cmdArray.length >= 2 && helpers.MyIsNumber(parseInt(cmdArray[1])))
        startTime = parseInt(cmdArray[1]);
    if (cmdArray.length >= 3 && helpers.MyIsNumber(parseInt(cmdArray[2])))
        stopTime = parseInt(cmdArray[2]);
    // Set default values for start Event and range if proper values not provided by user
    if (!startTime) { startTime = 0; }
    if (!stopTime) { stopTime = Date.now(); }

    if (cmdArray.length > 3) // contains logical train ids
        trainsArray = cmdArray.slice(3, cmdArray.length); // send the train ids as an array to playHistory
    else
        trainsArray = null; // no logical train ids given, send null value to playHistory to have all trains played back

    if (trainsArray && Array.isArray(trainsArray)) { // only play back specific trains
        aggSomeTrains (toSocketID, startTime, stopTime, trainsArray);
    }
    else {
        aggAllTrains (toSocketID, startTime, stopTime);
    }
} // handleAggregateSend ()

const aggSomeTrains = function (toSocketID, startTime, stopTime, trainsArray) {
    let multi = redisStore.multi();
    let i;

    assert (typeof toSocketID === "string");
    assert (typeof startTime === "number");
    assert (typeof stopTime === "number");
    assert(Array.isArray(trainsArray));

    // get eventIDs per train within given range
    for (i = 0; i < trainsArray.length; i++) {
        multi.zrangebyscore(keyMgr(opStore.cts_logical_nr, trainsArray[i]), startTime, stopTime, "limit", 0, 1000/trainsArray.length);
    }
    multi.exec(function (err, replies) {
        // replies is an array with one record per zrangebyscore call
        // each record contains the eventIDs for a given train within the range
        let index;
        let eventIDs = [];
        let tmpSocket = io.sockets.connected[toSocketID];

        if (!tmpSocket) {
            log.warn("aggSomeTrains - internal error, communications ID not found " + toSocketID);
            socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
            return;
        }

        if (err) {
            log.warn("aggSomeTrains. Error retrieving history data: " + err);
            return;
        }

        // Now, get the actual cts-events (not only their ID)
        //tmpSocket.historyList = new Array(replies.length);
        for (index = 0; index < replies.length; index++) {
            eventIDs = replies[index];
            //retrieveandplay(toSocketID, keyMgr(opStore.cts), eventIDs, playbackFn);
            redisStore.hmget(keyMgr(opStore.cts), eventIDs, function (err, ctsEvents) {
                let flatmsgObject = null, msgObject = null;
                let eventCTSList = [];
                let j = 0;
                if (err) {
                    log.error("aggSomeTrains. Unable to retrieve hash per train: " + err);
                    return;
                }
                for (j = 0; j < ctsEvents.length; j++) {
                    if (!ctsEvents[j]) {
                        log.error("aggSomeTrains. Unexpected null value in event data at index: " + i + " " + ctsEvents[i]);
                        continue;
                    }
                    flatmsgObject = JSON.parse(ctsEvents[j]);
                    msgObject = unflatten(flatmsgObject);
                    eventCTSList.push(msgObject);
                }
                log.info("aggSomeTrains. eventCTSList.length: " + eventCTSList.length);
                aggregateAndSendEvents(toSocketID, "cts", eventCTSList); // play back event list for one trai
            }); //exec get and send event-hashes per train
        } // iterate all trains
    }); // exec zrangebyscore get all eventIDs within range
}; // aggSomeTrains()

const aggAllTrains = function (toSocketID, startTime, stopTime) {
    let flatmsgObject = null, msgObject = null;
    let eventChunkTimeRange = 1000;
    let i;

    assert(typeof toSocketID === "string");
    assert(typeof startTime === "number");
    assert(typeof stopTime === "number");
    assert(typeof callback === "function");

    /* testing...
    toArray(redisStore.scan({pattern: "*", count: 100}), function(err, arr) {
        if (err)
            throw err;

        console.log("scan: " + arr);
    });
    toArray(redisStore.zscan(keyMgr(opStore.cts_timestamp),{pattern: "*", count: 100}), function(err, arr) {
        if (err)
            throw err;

        console.log("zscan: " + arr);
    });
    */

    redisStore.zrangebyscore(keyMgr(opStore.cts_timestamp), startTime, stopTime, "limit", 0, 1000, function (err, eventIDs) {
        if (err) {
            log.warn("aggAllTrains - Redis count error: " + err);
            return;
        }
        //console.log ("playAllTrains - eventIDs: " + eventIDs.toString());
        if (!eventIDs) {
            console.log("aggAllTrains - no cts events found!");
            return;
        }
        redisStore.hmget(keyMgr(opStore.cts), eventIDs, function (err, ctsEvents) {
            let msgObject = null, flatmsgObject = null;
            let tmpSocket = null;
            let trainObj = {};
            let prop = null;
            let i = 0;
            if (err) {
                log.warn("aggAllTrains - Redis could not retrieve historical data: " + err);
                return;
            }
            if (!Array.isArray(ctsEvents)) {
                log.warn("aggAllTrains - Redis request did not return valid response. Expected array: " + ctsEvents);
                return;
            }

            tmpSocket = io.sockets.connected[toSocketID];
            if (!tmpSocket) {
                log.error("aggAllTrains - Internal communications error. Connection lost: " + toSocketID);
                return;
            }

            for (i = 0; i < ctsEvents.length; i++) {
                flatmsgObject = JSON.parse(ctsEvents[i]);
                msgObject = unflatten(flatmsgObject);
                if (!trainObj.hasOwnProperty(msgObject.values.address)) {
                    trainObj[msgObject.values.address] = [];
                }
                trainObj[msgObject.values.address].push(msgObject);
            }
            for (prop in trainObj) {
                aggregateAndSendEvents(toSocketID, "cts", trainObj[prop]);
                log.info("aggAllTrains. length trainObj[" + prop + "] : " + trainObj[prop].length + " test: " + Array.isArray(trainObj[prop]));
            }
        }); // redis hmget-callback
    }); // redis zrange-callback
}; //aggAllTrains()

function aggregateAndSendEvents (toSocketID, channel, eventArray) {
    let tmpSocket = null;
    let eventObj = {}, currentEvent = null, eventList = [];
    let Name = null;

    assert(typeof toSocketID === "string");
    assert(typeof channel === "string");
    assert(Array.isArray(eventArray));

    tmpSocket = io.sockets.connected[toSocketID];

    if (!tmpSocket) {
        log.error("aggregateAndSendEvents - Internal communications error, invalid toSocketID " + toSocketID);
        return;
    }

    if (eventArray.length === 0) {
        log.error("aggregateAndSendEvents -- eventArray out of range");
        return;
    }
    // reduce history list to array of only unique berths, sorted in the order they are encountered and with a "Count" value equal to the number of times the berth occur in historyList
    for (let i = 0; i < eventArray.length; i++) {
        currentEvent = eventArray[i];
        Name = getToBerthName(currentEvent);

        if (!Name || !checkToBerthLatLng(currentEvent))
            continue; // CTS event invalid for aggregate
        if (!eventObj.hasOwnProperty(Name)) {
            currentEvent.Count = 1;
            eventList.push(currentEvent);               // save event
            eventObj[Name] = eventList.length - 1;  // save index for easy lookup
        }
        else {
            eventList[eventObj[Name]].Count = eventList[eventObj[Name]].Count + 1;
        }
    }
    /*
     for (var i=0; i<eventList.length; i++) {
     console.log ("eventList[" + i + "] Adress/Train: " + eventList[i].values.address + " to_infra_berth: " + eventList[i].values.to_infra_berth.Name + " Timestamp: " + eventList[i].values.time_stamp + " Count: " + eventList[i].Count);
     }
     */
    io.to(toSocketID).emit("aggregatehistory", eventList);
    eventArray = []; // memory ok for garbage collection
    eventObj = null;
} // aggregateAndSendEvents()

module.exports = function (pio) {
    if (pio) {
        io = pio;
    }
    return CTSHistory;
}
