/**
 * Created by christianthindberg on 03/10/2016.
 */

"use strict";

const helpers = require ("./helpers");
const ctsrealtime = require ("./ctsrealtime");
const opstore = require ("./opstore");

let io = null;
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

Command.help = function (cmdArray, socket) {
    socket.emit("help", cmdDictionary);
};

Command.flushAll = function (cmdArray, socket) {
    if (cmdArray.length !== 2 || cmdArray[1] !== "Poker") {
        return;
    }
    opstore.flushAll();
    /*
        if (err) {
            socket.emit("chat message", "Flush failed: " + err);
            return;
        }
        socket.emit("chat message", "Flush succeeded: " + succeeded);
    });
    */
}; // flushAll ()

Command.master = function (cmdArray, socket) {
    if (cmdArray.length !== 2 || cmdArray[1] !== "Poker") {
        // only return state
        socket.emit("chat message", "OsloMetro - master state is: " + opstore.isMaster());
        return;
    }
    opstore.setMaster(!opstore.isMaster()); // Toggle master state
    socket.emit("chat message", "OsloMetro - New master state: " + opstore.isMaster());
}; // master ()

Command.getCTSEvent = function (cmdArray, socket) {
    if (cmdArray.length === 1 || !helpers.MyIsNumber(parseInt(cmdArray[1]))) {
        socket.emit("chat message", "Error: Missing legal eventID");
        return;
    }

    opstore.hget(keyMgr(opstore.cts), cmdArray[1], function (err, object) {
        let flatmsgObject = JSON.parse(object);
        let msgObject = unflatten(flatmsgObject);
        socket.emit("chat message", "Redis says: " + err + " " + JSON.stringify(msgObject, undefined, 2));
    });
}; // getCTSEvent()

Command.getCTSLastEventID = function (cmdArray, socket) {
    opstore.get('CTS_EVENT_ID', function (err, eID) {
        if (err) {
            console.log("redis error trying to get key CTS_EVENT_ID: " + err);
            return;
        }
        socket.emit("chat message", "CTS_EVENT_ID: " + eID + " eventID: " + eventID);
    });
}; // get CTSLastEventID ()

Command.getTrains = function (cmdArray, socket) {
    opstore.smembers(keyMgr(opstore.cts_logical_nr_keys), function (err, cts_logical_nr_Keys) { // get all logical train keys
        if (err) {
            console.log("smembers error: " + err);
        }
        else {
            socket.emit('trains', cts_logical_nr_Keys);
        }
    });
}; // getTrains()

Command.getOkBerths = function (cmdArray, socket) {
    let toSocketID, tmpSocket;
    if (!socket.joined) {
        socket.emit("help", {"berth": cmdDictionary.berth});
        return;
    }
    toSocketID = socket.room;
    tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID|| !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }
    socket.to(toSocketID).emit("okberths", ctsrealtime.getBerthsReceivedObject());
    //io.emit('okberths', ctsOKObject);
}; // getOkBerths ()

Command.getFirstAndLastCTSEvent = function (cmdArray, socket) {
    const multi = redisStore.multi();
    multi.zrange(keyMgr(opstore.cts_timestamp), 0, 0, "withscores");
    multi.zrange(keyMgr(opstore.cts_timestamp), -1, -1, "withscores");
    multi.exec(function (err, result) {
        if (err) {
            console.log("Unable to retrieve range. Error: " + err);
            return;
        }
        socket.emit('range', { "startID": result[0][0], "startTime": result[0][1], "stopID": result[1][0], "stopTime": result[1][1] });
    });
}; // getFirstAndLastCTSEvent ()

Command.setMaxCTSEvents = function (cmdArray, socket, maxCTS) {
    if (cmdArray.length !== 2 || !helpers.MyIsNumber(parseInt(cmdArray[1]))) { // just return current maxCTS
        socket.emit('chat message', "OsloMetro - max number of records to track in Redis is: " + maxCTS);
    }
    socket.emit('chat message', "OsloMetro - max number of records to track in Redis changed. Old max " + maxCTS + " New max: " + cmdArray[1]);
    return parseInt(cmdArray[1]);
}; // setMaxCTSEvents ()

Command.countCTSEvents = function (cmdArray, socket) {
    opstore.zcount(keyMgr(opstore.cts_timestamp), "-inf", "+inf", function (err, count) {
        if (err) {
            socket.emit("chat message", "Received Redis error: " + err);
            return;
        }
        socket.emit("chat message", "Number of cts-events stored: " + count);
    });
}; // countCTSEvents()

Command.setBlinkAlarms = function (cmdArray, socket) {
    if (!socket.joined) {
        socket.emit("help", {"blink": cmdDictionary.blink});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID|| !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }
    socket.to(toSocketID).emit("blinkalarms", null);
    //socket.emit('blinkalarms', null);
}; // setBlinkAlarms ()

Command.setDestination = function (cmdArray, sockets) {
    if (!socket.joined) {
        socket.emit("help", {"destination": cmdDictionary.destination});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!toSocketID|| !tmpSocket) {
        socket.emit("chat message", "internal error - communications ID not found (socket.room) " + toSocketID);
        return;
    }
    socket.to(toSocketID).emit("destination", null);
    //io.emit('destination', null);
}; // setDestination ()

Command.generateTestGhosts = function (cmdArray, sockets) {
    // create 3 ghost msgObjects by changing train address to "----" and send to clients
    // used for testing
    if (!socket.joined) {
        socket.emit("help", {"ghost": cmdDictionary.ghost});
        return;
    }
    let toSocketID = socket.room;
    let tmpSocket = io.sockets.connected[toSocketID];
    if (!tmpSocket) {
        console.error("Internal communication error. Socket not found: " + toSocketID);
        return;
    }
    for (var train in ctsLiveObject) {
        var msgObject = JSON.parse(JSON.stringify(ctsLiveObject[train][0]));
        msgObject.values.address = "----";
        parseAndSendCTS(toSocketID, "cts", msgObject);
        ++i;
        if (i == 3)
            return;
    }
}; // generateTestGhosts ()

Command.getSockets = function (cmdArray, socket) {
    let tmpSocket = [];
    for (var sock in io.sockets.connected) {
        var bJoined = io.sockets.connected[sock].joined ? true : false;
        let mode = io.sockets.connected[sock].mode;
        tmpSocket.push(io.sockets.connected[sock].id.toString() + " " + io.sockets.connected[sock].room + " Joined: " + bJoined + " mode: " + mode);
    }
    socket.emit('socketlist', tmpSocket);
}; // getSockets()

Command.join = function (cmdArray, socket) {
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
}; // join ()


module.exports = function (pio) {
    io = pio;
    return Command;
};