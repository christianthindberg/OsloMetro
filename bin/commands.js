/**
 * Created by christianthindberg on 03/10/2016.
 *
 * Command Line Interface for Oslo Metro
 * Mostly getting information from opstore
 * Also information regarding sockets
 */

"use strict";

const helpers = require ("./helpers");
const opstore = require ("./opstore");
const assert = require ("assert");
const logger = require('./logger');
const log = logger().getLogger('commands');

let io = null;

const ctslivestatus = require("./ctslivestatus")(null);
const ctshistory = require("./ctshistory")(null);

let cmdDictionary = {
    sub:        "subscribe to some redis channels. Used to verify that connection to Redis is ok",
    flushall:   "empty the Redis database",
    master:     "get master state. True=this server is pushing data to Redis. Enter password to toggle state",
    cts:        "cts <eventNr>:  Retrieves 1 cts event from Redis. If eventNr is not given the oldes event is returned",
    eventid:    "Retrieve the CTS_EVENT_ID'key. This key is the ID of the last CTS event we have received. The ID of the next event will be CTS_EVENT_ID+1",
    join:       "join <socket.id>: Connects a console to a map and enable console to send commands to the map",
    unjoin:     "not implemented",
    aggregate:  "visualize how many times one/several/all trains have passed the berths. Visualized in map-client",
    history:    "history <fromEvent> <toEvent>.  History is played back into joined map-client",
    cancel:     "Cancel on-going history playback for joined map-client",
    realtime:   "sets joined map-client back to normal, i.e. map-client starts receiving realtime events. Any on-going history playback is cancelled",
    trains:     "list all logical train IDs",
    trains_phys: "list all physical three-car IDs (Note: not yet implemented)",
    range:      "Returns the first and last eventID we have stored and their associated times",
    info:       "Retrieves information about the Redis database",
    redis:      "List available redis-commands",
    sockets:    "List currently connected sockets and their join-status",
    max:        "max <number>. If no number is provided returns the max number of cts-events that will be kept in Redis. If number is provided sets the max number of records to keep",
    count:      "retrieves the number of cts events stored in Redis",
    berth:      "Colors berths that we have not received data from RED and the other berths GREEN. Do <berth> again to reset coloring to normal",
    blink:      "Strong visualization of certain events (i.e. logical train ID chagen). Affected elements will blink. Right-click on element to stop the blinking. Send <blink> again to reset to normal visualization",
    destination: "Toggle trains display between <trainid> and <destination>",
    ghost:      "create some ghost signals and send to joined map-client for testing"
}; // cmdDictionary

let Command = {
    version: 1.0
}; // Command

Command.parseAndDo = function (cmdArray, socket) {
    assert(Array.isArray(cmdArray));
    assert(typeof socket === "object");

    switch (cmdArray[0]) {
        case "?":
        case "help":
            help(cmdArray, socket);
            break;
        case "sub":
            let topic = cmdArray.length > 1 ? cmdArray[1] : "test";
            opstore.subscribe(topic);
            break;
        case "flushall":
            flushAll(cmdArray, socket);
            break;
        case "master":
            master(cmdArray,socket);
            break;
        case "cts":
            getCTSEvent(cmdArray, socket);
            break;
        case "eventid":
            getCTSLastEventID (cmdArray, socket);
            break;
        case "join":
            join (cmdArray, socket);
            break;
        case "unjoin":
            // not implemented
            break;
        case "aggregate":
            ctshistory.handleAggregateSend (socket, cmdArray);
            break;
        case "history":
            //tshistory.handleHistoryPlayback (socket, cmdArray);
            opstore.scanStore();
            break;
        case "cancel":
            ctshistory.handlePlaybackCancel(socket, cmdArray);
            break;
        case "realtime":
            handleRealtime(socket, cmdArray);
            break;
        case "trains":
            getTrains (cmdArray, socket);
            break;
        case "range":
            getFirstAndLastCTSEvent (cmdArray, socket);
            break;
        case "info":
            socket.emit('chat message', "Info: " + JSON.stringify(opstore.getStoreInfo(), undefined, 2));
            break;
        case "redis":
            socket.emit('chat message', "Redis commands: " + JSON.stringify(opstore.getStoreCommands(), undefined, 2));
            break;
        case "max":
            setMaxCTSEvents (cmdArray, socket);
            break;
        case "count":
            countCTSEvents (cmdArray, socket);
            break;
        case "sockets":
            getSockets (cmdArray, socket);
            break;
        case "berth":
            getOkBerths (cmdArray, socket);  // send berths from which we have received signal to joined client for visualization
            break;
        case "blink":
            setBlinkAlarms (cmdArray, socket);
            break;
        case "destination":
            setDestination (cmdArray, socket);
            break;
        case "ghost":
            generateTestGhosts (cmdArray, socket);
            break;
    }
} // ParseAndDo()

function help (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");

    socket.emit("help", cmdDictionary);
} // help ()

function flushAll (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");

    if (cmdArray.length !== 2 || cmdArray[1] !== "poker") {
        return;
    }
    opstore.flushAll(function (err, reply) {
        if (err) {
            socket.emit("chat message", "Flush failed: " + err);
            return;
        }
    socket.emit("chat message", "Flush succeeded: " + reply);
    });
} // flushAll ()

function master (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");


    if (cmdArray.length !== 2 || cmdArray[1] !== "poker") {
        // only return state
        socket.emit("chat message", "OsloMetro - master state is: " + opstore.isMaster());
        return;
    }
    opstore.setMaster(!opstore.isMaster()); // Toggle master state
    socket.emit("chat message", "OsloMetro - New master state: " + opstore.isMaster());
} // master ()

function getCTSEvent (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");


    if (cmdArray.length === 1 || !helpers.MyIsNumber(parseInt(cmdArray[1]))) {
        socket.emit("chat message", "Error: Missing legal eventID" + cmdArray[1]);
        return;
    }

    opstore.getCTSEventByID (parseInt(cmdArray[1]), function (err, result) {
        if (err) {
            socket.emit("chat message", "Get CTS event failed: " + err);
        }
        else {
            socket.emit("chat message", "CTS Event " + cmdArray[1] + ": " + JSON.stringify(result, undefined, 2));
        }
    });
} // getCTSEvent()

function getCTSLastEventID (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");

    opstore.getLastCTSEventID (function (err, eID) {
        if (err) {
           socket.emit("chat message", "Could not retrieve last Event ID. Error: " + err);
        }
        else {
            socket.emit("chat message", "Last Event ID: " + eID);
        }
    });
} // get CTSLastEventID ()

function getTrains (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");

    opstore.getTrainNumbersLogical(function (err, trainNumbers) { // get all logical train keys
        if (err) {
            socket.emit("chat message", "Unable to retrive train numbers. Error: " + err);
            log.warn("getTrains. smembers error: " + err);
        }
        else {
            socket.emit('trains', trainNumbers);
        }
    });
} // getTrains()

function getFirstAndLastCTSEvent (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");

    opstore.getFirstAndLastCTSEvent (function (err, result) {
        if (err) {
            log.warn("getFirstAndLastCTSEvent. Unable to retrieve range. Error: " + err);
            socket.emit('chat message', "Unable to retrieve first and last event. Error: " + err);
            return;
        }
        let ev1 = result[0][1];
        let ev2 = result[1][1];
        let ev1ID = ev1[0];
        let ev1Time = ev1[1];
        let ev2ID = ev2[0];
        let ev2Time = ev2[1];
        socket.emit('range', { "startID": ev1ID, "startTime": ev1Time, "stopID": ev2ID, "stopTime": ev2Time });
    });
} // getFirstAndLastCTSEvent ()

function setMaxCTSEvents (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");

    let currentMax = opstore.getMaxCTSEvents();
    let newMax;

    if (cmdArray.length === 1) { // just return current maxCTS
        socket.emit('chat message', "OsloMetro - max number of records to track in Redis is: " + currentMax);
        return;
    }
    newMax = parseInt(cmdArray[1]);
    if (!helpers.MyIsNumber(newMax)) {
        socket.emit("chat message", "max CTS Events must be number: " + newMax);
        return;
    }
    newMax = opstore.setMaxCTSEvents(newMax);
    socket.emit("chat message", "OsloMetro - max number of records to track in Redis changed. Old max " + currentMax +
        " New max: " + newMax);
} // setMaxCTSEvents ()

function countCTSEvents (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");

    opstore.countCTSEvents(function (err, result) {
        if (err) {
            socket.emit("chat message", "Uanble to get count of events. Error: " + err);
            return;
        }
        socket.emit("chat message", "Number of cts-events stored: " + result);
    });

} // countCTSEvents()

function getOkBerths (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray));
    assert.ok(typeof socket === "object");


    let toSocketID, tmpSocket;
    if (!socket.joined) {
        socket.emit("help", {"berth": cmdDictionary.berth});
        return;
    }
    toSocketID = socket.room;
    tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID|| !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        log.warn("getOkBerths. internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }
    io.to(toSocketID).emit("okberths", ctslivestatus.getBerthsReceivedObject());
    //io.emit('okberths', ctsOKObject);
} // getOkBerths ()

function setBlinkAlarms (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray), "function BlinkAlarms invalid parameter cmdArray: " + cmdArray);
    assert.ok(typeof socket === "object");

    if (!socket.joined) {
        socket.emit("help", {"blink": cmdDictionary.blink});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID|| !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        log.warn("setBlinkAlarms. internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }
    socket.to(toSocketID).emit("blinkalarms", null);
    //socket.emit('blinkalarms', null);
} // setBlinkAlarms ()

function setDestination (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray), "function setDestination invalid parameter cmdArray: " + cmdArray);
    assert.ok(typeof socket === "object");

    if (!socket.joined) {
        socket.emit("help", {"destination": cmdDictionary.destination});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID|| !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        log.warn("setDestination. internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }
    socket.to(toSocketID).emit("destination", null);
    //io.emit('destination', null);
} // setDestination ()

function generateTestGhosts (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray), "function generateTestGhosts invalid parameter cmdArray: " + cmdArray);
    assert.ok(typeof socket === "object");

    const tmpCTSLive = ctslivestatus.getLiveObject();
    let countGhosts = 0;

    // create 3 ghost msgObjects by changing train address to "----" and send to clients
    // used for testing
    if (!socket.joined) {
        socket.emit("help", {"ghost": cmdDictionary.ghost});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        log.error("generateTestGhosts. Internal communication error. Socket not found: " + toSocketID);
        return;
    }
    for (let train in tmpCTSLive) {
        let msgObject = JSON.parse(JSON.stringify(ctslivestatus.getLiveObject(train)[0])); // make a copy
        msgObject.values.address = "----";
        //parseCTSData(toSocketID, "cts", msgObject);
        opstore.publish("cts", JSON.stringify(msgObject));
        ++countGhosts;
        if (countGhosts === 3)
            return;
    }
} // generateTestGhosts ()

function getSockets (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray), "Command -set MaxCTSEvents invalid paramter cmdArray: " + cmdArray);
    assert.ok(typeof socket === "object");

    let tmpSocket = [];
    for (var sock in io.sockets.connected) {
        var bJoined = io.sockets.connected[sock].joined ? true : false;
        let mode = io.sockets.connected[sock].mode;
        tmpSocket.push(io.sockets.connected[sock].id.toString() + " " + io.sockets.connected[sock].room + " Joined: " + bJoined + " mode: " + mode);
    }
    socket.emit('socketlist', tmpSocket);
} // getSockets()

function join (cmdArray, socket) {
    assert.ok(Array.isArray(cmdArray), "Command -set MaxCTSEvents invalid paramter cmdArray: " + cmdArray);
    assert.ok(typeof socket === "object");

    let socketid = null;
    if (cmdArray.length !== 2 || !io.sockets.connected[cmdArray[1]]) {
        socket.emit("help", {"join": cmdDictionary.join});
        return;
    }
    socketid = cmdArray[1];
    socket.leave(socket.room);
    socket.join(socketid);
    socket.room = socketid;
    socket.joined = true;
    io.to(socketid).emit("chat message", socket.id + " joined to client " + socketid);
} // join ()


module.exports = function (pio) {
    if (pio) {
        io = pio;
    }
    return Command;
};