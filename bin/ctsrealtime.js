/**
 * Created by christianthindberg on 04/10/2016.
 *
 * Parse incoming CTS Events
 * Store events and emit to clients
 * Provide information on events to clients (via www) and to users (through the commands module)
 */


"use strict";

const infrastructure = require("./infrastructure");
const helpers = require("./helpers");
const opstore = require("./opstore");
const assert = require("assert");
const logger = require("./logger");
const log = logger().getLogger("ctsrealtime");


let ctsLiveObject = {}; // train berth, ... live data from cts
let ctstrainChangeSuspectObject = {}; // trains we believe have changed their logical number
//let ctsHistoryList = []; // identical to live object but with historical data
let ctsGhosts = {}; // some times we receive "noise" or incorrect data from the signalling system, referred to as "ghost trains"

let ctsOKObject = {}; // for debug all berths that we have managed to match agains list from InfrastrukturEnheten
let destinationObject = {}; // for debug, all destinations received from the trains
let missingToBerths = {};
let missingFromBerths = {};
let trainChangeNoBerths = {};
let specialBerths = {};
let trainNumbers = {};

let io = null;

let CTSRealTime = {
    version: 1.0
};


CTSRealTime.getLiveObject = function (train) {

    if (!ctsLiveObject) {
        return null;
    }
    if (train) {  // asking for specific train?
        return ctsLiveObject.hasOwnProperty(train) ? ctsLiveObject[train] : null;
    }
    // return the full set of Live Data
    return ctsLiveObject;
}; // getLiveObject()


CTSRealTime.getBerthsReceivedObject = function () {
    return ctsOKObject;
}; // getBerthsReceivedObject()

CTSRealTime.getTail = function (trainNo, noOfBerths) {
    let n = 0;
    assert (typeof trainNo === "string");
    assert(typeof noOfBerths === "number");

    // Server lacking data?
    if (!CTSLiveObject[trainNo]) {
        return null;
    }
    n = Math.min(CTSLiveObject[trainNo].length, noOfBerths);
    return CTSLiveObject[trainNo].slice(0, n);
}; // getTail()

CTSRealTime.getAllTails = function (maxBerths) {
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

CTSRealTime.getGhosts = function () {
    // return the full set of Live Data
    return ctsGhosts;
}; // getCTSLiveObject()

const trainsInTraffic = setInterval(function fNtrainsInTraffic () {
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
const removeTrains = setInterval(function fNremoveTrains () {
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
/* Format av the message we receive on topic "cts"
 {
 "topic"
 :
 "cts", "values"
 :
 {
 "from_infra_berth"
 :
 {
 "Name"
 :
 "R0852T", "Latitude"
 :
 59.94284, "Longitude"
 :
 10.618624
 }
 ,
 "to_infra_berth"
 :
 {
 "Name"
 :
 "R0878T", "Latitude"
 :
 59.941393, "Longitude"
 :
 10.616812
 }
 ,
 "time_stamp"
 :
 "2016-03-20T11:23:05Z", "sequence_no"
 :
 0, "interlocking_id"
 :
 "OST", "from_berth"
 :
 "R852 ", "to_berth"
 :
 "R878 ", "address"
 :
 "508", "path"
 :
 "0111", "destination"
 :
 "ØSÅ2", "delay"
 :
 -82, "arrive_depart"
 :
 " ", "platform"
 :
 " ", "ars_mode"
 :
 "T", "metadata"
 :
 {
 "dataType"
 :
 "tuv", "dataMock"
 :
 false, "isSafeFromDelete"
 :
 false, "dataPartition"
 :
 "tuv-2016-03-20-508", "entryAssembly"
 :
 null, "operatingDayOslo"
 :
 "2016-03-20", "drivTimeStamp"
 :
 "2016-03-20T11:23:15.9189806Z"
 }
 }
 }
 */


// The concept of Lines is used to inform passengers about the end-stations assosiated with a certain train-movement.
// In reality, there are exceptions from this simple concept and the signalling system do not report which line is associated with a train
// We deduct line as follows
// 1. Look at the destination. Bergkrystallen may be line 1 or 4, Vestli may be line 4 or 5. Destination may also be Majorstua or any other station that could be any line
//      if Destination is unique such as Sognsvann (line 5) we use this
// 2. Look at to_berth. If this berth is traficked by only 1 line, this is what we will use
// 3. Look at where the train has been. Find the last berth it passed that is associated with only 1 line
// 4. If train has not been at a "one-line-only" berth, look at the train-number. For 3-digit trainnumbers the first digit is normally the line
// 5. Special cases: Trains numbered 17xx and 13xx are trams, *01 and similar are normal trains but CTS has "lost" its original number, 3-digit trainnumbers are normal and in most cases the first digit is equal to the line,
//     so if the train is not a tram, not "*train", not normal train - then it is most likely a maintenance train not used by passengers...


// todo: check berths vs elements

/**
 *
 * @param room
 * @param channel
 * @param msgObject: event sent from CTS via Driv
 *
 * events arrive out of order and it has happened that same event has arrived several times
 * events such as a train changing its logical number are not recorded
 * events do not contain information on which line the train is servicing
 * event properties contain spaces. These are removed
 * trains sometimes "jump" i.e. they do not move according to the infrastructure masterdata
 * parseAndSendCTS calculate "missing" events (i.e. trainChange) and adds "missing" information.
 * All events - also calculated - are then stored in opStore according to their timestamp (which is assumed to be more correct than their arrival order
 *
 * Anomalies are recorded, i.e. stored in opstore
 *
 */
CTSRealTime.parseAndSendCTS = function (room, channel, msgObject) {
    let trainNo = 0;
    let CTS_fromBerthObject = null;
    let CTS_fromBerth = null;
    let CTS_toBerth = 0;
    let CTS_toBerthObject = null;
    let timestamp = null;

    assert (typeof room === "string");
    assert (typeof channel === "string");
    assert(typeof msgObject === "object");

    // todo: fix all emits/room
    if (!msgObject.values) {
        log.error("paseAndSendCTS. Received msgObject without values: " + JSON.stringify(msgObject, undefined, 2));
        return;
    }
    msgObject = helpers.removeSpaces(msgObject);

    // todo: remove
    trainNo = msgObject.values.address;
    CTS_fromBerthObject = msgObject.values.from_infra_berth;
    CTS_fromBerth = msgObject.values.from_berth;
    CTS_toBerthObject = msgObject.values.to_infra_berth;
    CTS_toBerth = msgObject.values.to_berth;
    timestamp = new Date(msgObject.values.time_stamp).getTime();

    // todo: document
    msgObject.values.isGhost = false;
    msgObject.values.isInvalidFromBerth = false;
    msgObject.values.isInvalidToBerth = false;
    msgObject.values.yellow = false;
    msgObject.values.isSpecialCode = false;
    msgObject.values.lastUniqueLine = 0;
    msgObject.values.Line = 0;
    msgObject.values.firstTime = false;

    // todo: save opstore
    // Update statistics on destinations and trainNumbers received from CTS
    helpers.incProperty(destinationObject, msgObject.values.destination);
    helpers.incProperty(trainNumbers, trainNo);

    logDisorder(false, timestamp); // set to true for a simple check of events arriving in increasing time. Logs out-of-order to console

    // There is no guarantee that CTSevents arrive in strict order, or that events arrive only once
    // Whenever a change of a train number is suspected, we keep the trains on a "suspect list" for a short while
    updateTrainNoChangeSuspects(trainNo, msgObject.values.time_stamp);

    // save opstore
    if (IsGhostTrain(trainNo)) {
        io.to(room).emit("cts_ghost_train", msgObject); // Notify all clients
        msgObject.values.isGhost = true;
        parseAndStoreGhostObject(msgObject);
        return;
    }

    msgObject.values.yellow = IsYellowTrain(trainNo);

    // Special CTS code?
    if (isSpecialCTSCode(CTS_toBerth) || isSpecialCTSCode(CTS_fromBerth)) {
        // todo: save to opstore
        helpers.incProperty(specialBerths, CTS_fromBerth);
        helpers.incProperty(specialBerths, CTS_toBerth);
        msgObject.values.isSpecialCode = true;
        io.to(room).emit("cts_special_code", msgObject);
        saveCTSEvent(msgObject);
        return;
    }

    msgObject.values.isInvalidFromBerth = isInvalidFromBerth (msgObject);
    msgObject.values.isInvalidToBerth = isInvalidToBerth(msgObject);
    if (msgObject.values.isInvalidToBerth){
        // saveInvalidCTSEvent(msgObject);
        return;
    }

    if (!msgObject.values.isInvalidFromBerth) {
        checkTrainNoChange(room, msgObject); // check if our train changed its number from the last time we heard from it and to now
    }

    // register that the current train arrived at this toBerth
    infrastructure.updateTrain(CTS_toBerthObject.Name, trainNo);

    msgObject.values.lastUniqueLine = getLastUniqueLine (msgObject);
    msgObject.values.Line = guessLine (msgObject);

    updateCTSLiveObject(room, msgObject);

    // keep track of the berths that we have received data from, for debug
    helpers.incProperty(ctsOKObject, CTS_toBerthObject.Name);

    saveCTSEvent(msgObject);
    io.to(room).emit(channel, [msgObject]); // pass on current train/berth as an array of 1 element

}; // parseandsendCTS ()

function checkTrainNoChange (room, msgObject) {
    assert(typeof msgObject === "object");
    // at this point, we can assume that we have a valid to_infra berth and from_infra_berth
    assert(msgObject.hasOwnProperty("values"));
    assert(msgObject.values.hasOwnProperty("to_infra_berth"));
    assert(msgObject.values.hasOwnProperty("from_infra_berth"));

    const fromBerthName = msgObject.values.from_infra_berth.Name; // CTS_fromBerthObject.Name;
    const toBerthName = msgObject.values.to_infra_berth.Name;
    const trainNo = msgObject.values.address;

    // check if the train has changed its number
    if (infrastructure.isNewTrainNoOnBerth(fromBerthName, trainNo)) { // train numbers are different, and we are on berth (not switch)
        // should only be possible if this train changed its number
        // in reality, there are errors - either in the masterdata or in CTS so that from_berth - to_berth reported by CTS does not match expected from_berth - to_berth in masterdata
        // our best approach is to conclude that a train has changed its number only if train numbers are different AND CTS and masterdata match
        if (infrastructure.isNextBerth(fromBerthName, toBerthName)) { // CTS and masterdata match...
            // We suspect train number change...
            const oldTrainNo = infrastructure.getLastTrainOnBerth(fromBerthName);
            if (ctstrainChangeSuspectObject.hasOwnProperty(oldTrainNo)) {
                // maybe we have received the same CTS-message several times? Or maybe the old train no is still valid?
                log.info("parseAndSendCTS. Suspected train number change was already registered. Train No: " + oldTrainNo + " New TrainNo: " + trainNo + ". Timestamp: " + msgObject.values.time_stamp);
            }
            else {
                log.info("parseAndSendCTS. Adding train to suspects. Old Train No: " + oldTrainNo + " New Train No: " + trainNo + ". Timestamp: " + msgObject.values.time_stamp);
                ctstrainChangeSuspectObject[oldTrainNo] = { "oldTrainNo": oldTrainNo, "newTrainNo": trainNo, "countCTSMsg": 0, "msgObject": msgObject};
                setTimeout(trainChangeNumber, 30*1000, room, oldTrainNo);
            }
        }
        else { // CTS and masterdata do not match Save:opstore....
            log.warn("Berth mismatch. Expected from: " + fromBerthName + " Infrastructure-to: " +  infrastructure.getNextBerth(fromBerthName) + " CTS-to: " + toBerthName);
            msgObject.values.jump_ctsFrom = fromBerthName;
            msgObject.values.jump_ctsTo = toBerthName;
            msgObject.values.jump_infraTo = infrastructure.getNextBerth(fromBerthName);
            io.to(room).emit("cts_train_jump", msgObject);
        }
    } // new train on berth
} // checkTrainNoChange()

function isInvalidFromBerth (msgObject) {
    assert (typeof msgObject === "object");

    if (!msgObject.values.from_infra_berth) { // this is a valid case, (f.ex entering from Ryen? or receiving special CTS-code like INTERP, CANCEL, LOST, EXIT
        helpers.incProperty(missingFromBerths, msgObject.values.from_berth); // for debugging - log that we encountered from-berth that was not matched
        return true;
    }
    if (!msgObject.values.from_infra_berth.Name) {
        log.warn("parseAndSendCTS. Got non-existing from_infra_berth.Name: " + CTS_fromBerthObject.Name);
        return true;
    }
    if (!infrastructure.isElement(msgObject.values.from_infra_berth.Name)) {
        log.warn("parseAndSendCTS. invalid from_infra_berth.Name: " + CTS_fromBerthObject.Name);
        return true;
    }
    return false;
} // isInvalidFromBerth()

function isInvalidToBerth (msgObject) {
    assert (typeof  msgObject === "object");

    if (!msgObject.values.to_infra_berth) {
        helpers.incProperty(missingToBerths, msgObject.values.to_berth); // for debugging - log that we encountered to-berth that was not matched
        //log.warn("parseAndSendCTS. msgObject did not contain to_infra_berth: " + JSON.stringify(msgObject, undefined, 2));
        //saveInvalidCTSEvent(msgObject);
        return true; // not going anywhere, just return
    }

    if (!infrastructure.isElement(msgObject.values.to_infra_berth.Name)) { // Invalid berth?
        log.warn("parseAndSendCTS. Got non-existing to_infra_berth.Name: " + CTS_toBerthObject.Name);
        //todo: helpers.incProperty invalid berth...
        //saveUnknownBerthCTSEvent(msgObject);
        return true; // not going anywhere we know of, ...
    }
    return false;
} // isInvalidToBerth()

function updateCTSLiveObject(room, msgObject) {
    const trainNo = msgObject.values.address;

    if (!ctsLiveObject.hasOwnProperty([trainNo])) { // first time we receive data for this trainNo, or it was previously deleted due to train number change
        //console.log("CTS-trainnumber_first_time: " + msgObject.values.address);
        msgObject.values.firstTime = true;
        io.to(room).emit("cts_trainnumber_first_time", msgObject); // notify the client
        ctsLiveObject[trainNo] = [];
    }
    // insert this berth event first in the list of events for this train
    ctsLiveObject[trainNo].unshift(msgObject);

    // do not allow the berth event list to grow forever
    while (ctsLiveObject[trainNo].length > 200) {
        ctsLiveObject[trainNo].pop();
    }
} // updateCTSLiveObject()

function saveCTSEvent(msgObject) {
    assert (typeof msgObject === "object");

    opstore.saveCTSEvent (msgObject, function (err, success) {
        if (err) {
            log.error("saveCTSEvent. saveCTSEvent error: " + err);
        }
    });
} // saveCTSEvent()

// Train is considered to be a "ghost" train/false signal if
// trainNo do not contain any alphanumeric characters.
// False signals typically have trainNo "----"
function IsGhostTrain(trainNo) {
    assert(typeof trainNo === "string");

    return !trainNo.match(/[0-9a-z*]/gi);
} // IsGhostTrain ()

function parseAndStoreGhostObject(msgObject) {
    let ghostBerth = null;
    assert(typeof msgObject === "object");
    assert(msgObject.hasOwnProperty("values"));

    ghostBerth = getBerthName(msgObject);
    // todo: save to opstore
    ctsGhosts[ghostBerth] = msgObject;
} // parseAndStoreGhostObject()

function updateTrainNoChangeSuspects(trainNo, timestampString) {
    assert(typeof trainNo === "string");
    assert(typeof timestampString === "string");
    if (ctstrainChangeSuspectObject.hasOwnProperty(trainNo)) { // train did not change number since we are still getting data from it
        ctstrainChangeSuspectObject[trainNo].countCTSMsg += 1;
        log.info ("Train change did not occur for train number: " + trainNo + ". Received events: " + ctstrainChangeSuspectObject[trainNo].countCTSMsg + " Timestamp: " + timestampString);
    }
} // updateTrainNoChangeSuspects()
/**
 * Small helper function used by parseAndStoreGhostObject and trainChangeNumber
 * Gets the "best" berth name to associate with an event
 * 1. from_infra_berth.Name
 * 2. to.infra_berth.Name
 * 3. from_berth
 * 4. to_berth
 * @param msgObject
 * @returns {name of berth}
 */
function getBerthName(msgObject) {
    let berth = null;
    assert (typeof msgObject === "object");

    if (msgObject.values.to_infra_berth && msgObject.values.to_infra_berth.Name)
        berth = msgObject.values.to_infra_berth.Name;
    else if (msgObject.values.from_infra_berth && msgObject.values.from_infra_berth.Name)
        berth = msgObject.values.from_infra_berth.Name;
    else if (msgObject.values.to_berth)
        berth = msgObject.values.to_berth;
    else if (msgObject.values.from_berth)
        berth = msgObject.values.from_berth;
    else
        berth = "Unknown";
    return berth;
} // getBerthName

function isSpecialCTSCode (code) {
    assert(typeof code === "string");
    return code === "INTERP" || code === "EXIT" || code === "LOST" || code === "CANCEL" || code === "NOTD";
}
/**
 * @return {boolean}
 */
function IsYellowTrain(trainNo) {
    let tn = null;
    assert(typeof trainNo === "string");

    if (trainNo.charAt(0) === "*") { // "star-train"
        return false;
    }
    tn = trainNo.replace(/[a-z*]/gi, ""); // remove letters and *
    if (helpers.MyIsNaN(parseInt(tn)) || parseInt(tn) < 100) {  // No digits in trainNo or digits less than 99 - should be yellow car
        return true;
    }
    return false;
} // IsYellowTrain ()

/**
 *
 * @param msgObject
 * @returns the last time the train was on a part ot the track that is unique for one line - which line was it? 0 if train has not been on a unique part of the tracks yet
 */
function getLastUniqueLine (msgObject) {
    let toBerthName = null;
    let trainNo = null;
    assert (typeof msgObject === "object");
    assert (msgObject.hasOwnProperty("values"));
    assert(msgObject.values.hasOwnProperty("to_infra_berth"));

    toBerthName = msgObject.values.to_infra_berth.Name;
    trainNo = msgObject.values.address;

    // Current berth unique to 1 line?
    if (infrastructure.isElementUniqueLine(toBerthName)) {
        return infrastructure.getElementFirstLine(toBerthName);
    }
    // Nothing in history?
    if (!ctsLiveObject.hasOwnProperty(trainNo) || !Array.isArray(ctsLiveObject[trainNo])) { // will happen on server startup as we receive the very first messages
        return 0;
    }
    // look into history, find last unique line we have been on
    if (ctsLiveObject[trainNo][0].values.lastUniqueLine) {
        return ctsLiveObject[trainNo][0].values.lastUniqueLine;
    }
    // still here?
    return 0;
} // getLastUniqueLine()

/**
 *
 * @param msgObject
 * @returns the number of the line that the train is most probably servicing. 0 if unable to guess
 */
function guessLine (msgObject) {
    assert (typeof msgObject === "object");
    assert (msgObject.hasOwnProperty("values"));

    // Unique destination?
    if (infrastructure.isStationUniqueLine(msgObject.values.destination)) {
        return infrastructure.getStationFirstLine(msgObject.values.destination);
    }

    // Have we been on a part of the tracks that is unique to 1 line?
    if (msgObject.values.lastUniqueLine) {
        return msgObject.values.lastUniqueLine;
    }

    // last resort, guess line from train number
    return guessLineNoFromTrainNo(msgObject.values.address);
} // guessLine()

function guessLineNoFromTrainNo (trainNo) {
    let tmpLine = 0;

    if (!trainNo)
        return 0;

    tmpLine = parseInt(trainNo.replace(/[a-z*]/gi, ""));
    if (!helpers.MyIsNumber(tmpLine)) {
        return 0;
    }
    else if (tmpLine > 99 && tmpLine < 999) {
        return tmpLine.toString().charAt(0);
    }
    else if (tmpLine > 999) {
        return 3; // trams going on the Kolsås track uses 4 digit trainNo´s
    }
    else { // give up
        return 0;
    }
} // guessLineNoFromTrainNo()

function trainChangeNumber (room, oldTrainNo) {
    let newTrainNo = -1;
    let msgObject = null;
    let trainChangeSuspectObject = null;

    assert(typeof room === "string");
    assert(typeof oldTrainNo === "string");
    assert(ctstrainChangeSuspectObject.hasOwnProperty(oldTrainNo));

    trainChangeSuspectObject = ctstrainChangeSuspectObject[oldTrainNo];
    log.info("trainChangeNumber. oldTrainNo: " + oldTrainNo);
    log.info("trainChangeSuspect: " + JSON.stringify(trainChangeSuspectObject, undefined, 2));

    newTrainNo = trainChangeSuspectObject.newTrainNo;
    msgObject = trainChangeSuspectObject.msgObject;

    assert(typeof newTrainNo === "string");
    assert(typeof msgObject === "object");

    if (trainChangeSuspectObject.countCTSMsg !== 0) {
        // we have received messages relating to the old trainNumber after we thought it had changed
        // Check how lang ago it is...
        if (!ctsLiveObject.hasOwnProperty(oldTrainNo)) {
            log.error ("Old train no: " + oldTrainNo + " was already deleted");
            return; // old train number object already deleted. This may happen if we receive the same CTS-message several times (?? is this true?)
        }

        let ctsEventTime = new Date(ctsLiveObject[oldTrainNo][0].values.time_stamp).getTime();
        let dateNow = Date.now(); // todo: fix to work even with playback
        if (dateNow - ctsEventTime < 20000) {  // received last event less than 20 secunds ago -> no train number change occured
            delete trainChangeSuspectObject[oldTrainNo]; // Not suspected anymore because there was _no_ change
            log.info("trainChangeNumber. No change of train number had occured. Train change no longer suspected for train: " + oldTrainNo);
            return; // train change had not happened
        }
    }

    // Train-number change occured, notify client
    // Notify clients
    log.info("CTS-trainnumber_changed. Oldnumber: " + oldTrainNo + " New number: " + newTrainNo + " msgObject.values.destination: " + msgObject.values.destination);
    io.to(room).emit("cts_trainnumber_changed", { "new_train_no": newTrainNo, "old_train_no": oldTrainNo, "msgObject": msgObject }); // notify the client
    //ctsLiveObject[msgObject.values.address] = JSON.parse(JSON.stringify(ctsLiveObject[Infra_fromBerthObject.TrainNumber])); // clone the object. "=" only assigns reference
    delete trainChangeSuspectObject[oldTrainNo]; // Not suspected anymore because change confirmed

    // Copy data for old train number to property for the new train number
    //console.log("ctsLiveObject[Infra_fromBerthObject.TrainNumber===" + Infra_fromBerthObject.TrainNumber + "]" + JSON.stringify(ctsLiveObject[Infra_fromBerthObject.TrainNumber],undefined,2));
    if (ctsLiveObject.hasOwnProperty([oldTrainNo])) {  // sometimes CTS sends same message twice, this is to avoid crashing the second time around...
        //ctsLiveObject[trainNo] = ctsLiveObject[Suspect.TrainNumber]; // JSON.parse(JSON.stringify(ctsLiveObject[Infra_fromBerthObject.TrainNumber]));
        //console.log("ctsLiveObject[Infra_fromBerthObject.TrainNumber===" + Infra_fromBerthObject.TrainNumber + "]" + JSON.stringify(ctsLiveObject[Infra_fromBerthObject.TrainNumber],undefined,2));
        delete ctsLiveObject[oldTrainNo];
        log.info("ctsLiveObject[" + oldTrainNo + "] deleted");
        helpers.incProperty(trainChangeNoBerths, getBerthName(msgObject)); // for debugging - log the from_berth that had trainNumber different from current trainNumber ("address")
    }
    else {
        log.warn("trainChangeNumber. No entry for ctsLiveObject[" + oldTrainNo + "]");
    }
    // todo: save to redis and in local cts that a train change number event occured...
    // delete from suspectList
    delete ctstrainChangeSuspectObject[oldTrainNo];
} //trainChangeNumber()

let testLastTimeStamp = 0; // todo: put inside LogDisorder

function logDisorder (on, timestamp) {
    assert (typeof on === "boolean");
    assert (typeof timestamp === "number");

    if (!on)
        return;

     // the code below is a simple demonstration that the cts-signal arrive out of time
    // only catches the situation where current event originated earlier than the previous event

     if (testLastTimeStamp === 0) {
        testLastTimeStamp = timestamp;
        console.log("Assigned testLastTimeStamp: " + testLastTimeStamp);
     }
     else {
         if (testLastTimeStamp > timestamp) {
             console.log("Time out of order! Prev timestamp: " + testLastTimeStamp + " Curr timestamp: " + timestamp);
         }
         else {
             testLastTimeStamp = timestamp;
         }
     }
} // logDisorder

// todo: not use ctsLive etc, not save to redis, ...
CTSRealTime.parseAndSendCTShistory = function (room, channel, msgObject) {
    let trainNo = 0;
    let CTS_fromBerthObject = null;
    let CTS_fromBerth = null;
    let CTS_toBerth = 0;
    let CTS_toBerthObject = null;
    //let timestamp = null;

    // todo: fix all emits/room
    if (!room || !channel || !msgObject || !msgObject.values) {
        console.error("paseAndSendCTS called with msgObject null. Other params: " + room + " " + channel);
        return;
    }
    msgObject = removeSpaces(msgObject);

    trainNo = msgObject.values.address;
    CTS_fromBerthObject = msgObject.values.from_infra_berth;
    CTS_fromBerth = msgObject.values.from_berth;
    CTS_toBerthObject = msgObject.values.to_infra_berth;
    CTS_toBerth = msgObject.values.to_berth;
    //timestamp = new Date(msgObject.values.time_stamp).getTime();

    // for testing only
    // the code below demonstrates that the cts-signal arrive out of time
    /*
     if (helpers.MyIsNaN(timestamp)) {
     console.log("Timestamp is not a number: " + timestamp);
     }
     else if (testLastTimeStamp === 0) {
     testLastTimeStamp = timestamp;
     console.log("Assigned testLastTimeStamp: " + testLastTimeStamp);
     }
     else {
     if (testLastTimeStamp > timestamp) {
     console.log ("Time out of order! Last time stamp: " + testLastTimeStamp + " Current timestamp: " + timestamp);
     }
     else {
     testLastTimeStamp = timestamp;
     }
     }
     */

    // Got message from Change Suspect?
    if (ctstrainChangeSuspectObject[trainNo]) { // train did not change number since we are still getting data from it
        ctstrainChangeSuspectObject[trainNo].countCTSMsg += 1;
        console.log ("Train change did not occur: " + trainNo);
    }

    // REDIS - store data
    // Store all CTS-data received, whether they are valid or not
    /*
     if (isMaster()) {
     redisStore.incr('CTS_EVENT_ID', function (err, eID) {
     let multi = redisStore.multi();
     if (err) {
     console.log("redis error: " + err);
     }
     else {
     eventID = eID;
     multi.hset(keyMgr(opstore.cts), eventID, JSON.stringify(flatten(msgObject))); //flatten(CTS_toBerthObject.Name
     // parameters are KEY, SCORE, MEMBER (or value)
     multi.zadd(keyMgr(opstore.cts_timestamp), timestamp, eventID); //JSON.stringify(msgObject), redis.print); // new Date(msgObject.values.time_stamp).getTime()  new Date(msgObject.values.time_stamp).getTime()
     multi.zadd(keyMgr(opstore.cts_logical_nr, trainNo), timestamp, eventID);
     multi.sadd(keyMgr(opstore.cts_logical_nr_keys), keyMgr(opstore.cts_logical_nr, trainNo)); // keep a set containg all logical train numbers
     multi.exec(function (err, data) {
     if (err)
     console.log("err: " + err + " data: " + data);
     });
     }
     }); // store to Redis
     }
     */

    //identifyLineNumberFromTrainNumber(msgObject);

    if (!trainNo.match(/[0-9a-z*]/gi)) { // trainNo does not contain any alphanumeric characters or "*"
        let ghostBerth = null;
        io.to(room).emit("cts_ghost_train", msgObject);
        if (CTS_toBerthObject && CTS_toBerthObject.Name)
            ghostBerth = CTS_toBerthObject.Name;
        else if (CTS_fromBerthObject && CTS_fromBerthObject.Name)
            ghostBerth = CTS_fromBerthObject.Name;
        else if (CTS_toBerth)
            ghostBerth = CTS_toBerth;
        else if (CTS_fromBerth)
            ghostBerth = CTS_fromBerth;
        else
            ghostBerth = "Unknown";

        ctsGhosts[ghostBerth] = msgObject;
        //console.log("ghost train: " + trainNo + " data: " + JSON.stringify(msgObject, undefined,2));
        return;
    }

    if (trainNo.charAt(0) === "*") { // "star-train"
        msgObject.values.yellow = false;
    }
    else {
        let tn = trainNo.replace(/[a-z*]/gi, ""); // remove letters and *
        if (helpers.MyIsNaN(parseInt(tn)) || parseInt(tn) < 100) {  // No digits in trainNo or digits less than 99 - should be yellow car
            msgObject.values.yellow = true;
            //console.log ("yellow car: " + trainNo);
        }
        else {
            msgObject.values.yellow = false;
        }
    }

    // Special CTS code?
    if (isSpecialCTSCode(CTS_toBerth) || isSpecialCTSCode(CTS_fromBerth)) {
        helpers.incProperty(specialBerths, CTS_fromBerth);
        helpers.incProperty(specialBerths, CTS_toBerth);
        io.to(room).emit("cts_special_code", msgObject);
        return;
    }
    // Check destination
    helpers.incProperty(destinationObject, msgObject.values.destination); // for debugging - make object where each property correspond to a destination and count each time destination occur
    // Check train number
    helpers.incProperty(trainNumbers, trainNo);

    // Check To Berth, only pass valid data to clients
    if (!CTS_toBerthObject) {
        helpers.incProperty(missingToBerths, CTS_toBerth); // for debugging - log that we encountered to-berth that was not matched
        return; // not going anywhere, just return
    }

    if (!infraObject.hasOwnProperty([CTS_toBerthObject.Name])) { // Invalid berth
        console.log("non-existing to_infra_berth.Name: " + CTS_toBerthObject.Name);
        return; // not going anywhere we know of, ...
    }

    // Check From Berth
    if (!CTS_fromBerthObject) { // this is a valid case, (f.ex entering from Ryen? or receiving special CTS-code like INTERP, CANCEL, LOST, EXIT
        //helpers.incProperty(missingFromBerths, CTS_fromBerth); // for debugging - log that we encountered from-berth that was not matched
    }
    else if (!CTS_fromBerthObject.Name) {
        console.log("non-existing from_infra_berth.Name: " + CTS_fromBerthObject.Name);
    }
    else if (!infraObject.hasOwnProperty([CTS_fromBerthObject.Name])) {
        console.log("invalid from_infra_berth.Name: " + CTS_fromBerthObject.Name);
    }
    else {  // we have a valid from_infra_berth and to_infra_berth, check if our train changed its number from the last time we heard from it and to now
        let Infra_fromBerthObject = infraObject[CTS_fromBerthObject.Name]; // InfraObject has information on the trainNumber that was on a given berth last

        if (!Infra_fromBerthObject) {
            console.error("Masterdata error - received unknown berth from CTS: " + JSON.stringify(CTS_fromBerthObject, undefined, 1));
            return;
        }

        // check if the train has changed its number
        if (Infra_fromBerthObject.itemtypeCode != "V" && Infra_fromBerthObject.TrainNumber != trainNo && Infra_fromBerthObject.TrainNumber != 0) {
            // hmm, the train number that was the last to pass our from_berth was different from this train,
            // should only be possible if this train changed its number
            // in reality, there are errors - either in the masterdata or in CTS so that from_berth - to_berth reported by CTS does not match expected from_berth - to_berth in masterdata
            // our best approach is to conclude that a train has changed its number only if CTS and masterdata match AND train numbers are different
            if (Infra_fromBerthObject.nextitemCode !== CTS_toBerthObject.Name) {
                console.error("Berth mismatch. Expected from: " + Infra_fromBerthObject.itemCode + " to: " + Infra_fromBerthObject.nextitemCode + " CTS reported from: " + CTS_fromBerthObject.Name + " to: " + CTS_toBerthObject.Name);
                msgObject.values.jump_infraFrom = Infra_fromBerthObject.itemCode;
                msgObject.values.jump_ctsFrom = CTS_fromBerthObject.Name;
                msgObject.values.jump_ctsTo = CTS_toBerthObject.Name;
                io.to(room).emit("cts_train_jump", msgObject);
            }
            else { // We suspect train number change...  TODO: it is the OLD train number we suspect has changed!!
                let oldTrainNo = Infra_fromBerthObject.TrainNumber;
                let cloneFromInfraBerthObject = JSON.parse(JSON.stringify(Infra_fromBerthObject)); // need to make a copy, otherwise object will be changed by the current train
                if (ctstrainChangeSuspectObject.hasOwnProperty(oldTrainNo)) {
                    // maybe we have received the same CTS-message several times? Or maybe the old train no is still valid?
                    console.log("Suspected train number change, but suspicion was already registered, presumably we have received same CTS-event again. Train No: " + oldTrainNo);
                }
                else {
                    console.log("Adding train to suspects. Train No: " + oldTrainNo);
                    ctstrainChangeSuspectObject[oldTrainNo] = { "countCTSMsg": 0, "newTrainNo": trainNo, "fromInfra":  cloneFromInfraBerthObject, "msgObject": msgObject};
                    setTimeout(function (r, oldTr) { return function () { return trainChangeNumber(r, oldTr); };}(room, oldTrainNo), 30*1000); // look weird? time to read up on javascript closures...
                    console.log("setTimeout: " + room + " object: " + JSON.stringify(ctstrainChangeSuspectObject[oldTrainNo]));
                }
            }
        } // train had changed its number
    } // valid from_infra_berth and to_infra_berth

    // register that the current train arrived at this toBerth
    infraObject[CTS_toBerthObject.Name].TrainNumber = trainNo;

    //let tmpLineTest = parseInt(msgObject.values.address.replace(/^\*|[a-z]+$/gi, ""));

    // Set value of lastUniqueLine for this msgObject
    if (infraObject[CTS_toBerthObject.Name].Lines.length == 1) { // we are on a berth that is unique to 1 line
        msgObject.values.lastUniqueLine = infraObject[CTS_toBerthObject.Name].Lines[0];
    }
    else if (!ctsLiveObject.hasOwnProperty([trainNo]) || !Array.isArray(ctsLiveObject[trainNo])) { // will happen on server start-up as we receive the first ctsEvents
        console.error("ctsLiveObject{[" + trainNo + "] does not contain array: " + JSON.stringify(ctsLiveObject[trainNo], undefined, 2));
        msgObject.values.lastUniqueLine = guessLineNoFromTrainNo(trainNo);
    }
    else if (ctsLiveObject[trainNo][0].values.lastUniqueLine) { // look into history, find last unique line we have been on
        msgObject.values.lastUniqueLine = ctsLiveObject[trainNo][0].values.lastUniqueLine;
    }
    else { // not on unique line-berth now, nothing in history... guess line from trainNo
        msgObject.values.lastUniqueLine = guessLineNoFromTrainNo(trainNo);
    }

    // Now we take our best shot at determining the Line that the Train is operating on
    if (stationObject[msgObject.values.destination] && stationObject[msgObject.values.destination].Lines.length == 1) {
        msgObject.values.Line = stationObject[msgObject.values.destination].Lines[0];
    }
    else {
        msgObject.values.Line = msgObject.values.lastUniqueLine;
    }

    // todo: consider using Redis as store for live objects and increase amount of data available to f.ex. 1 week
    // and implement f.ex. "replay" of events

    // todo: check for valid train number, ie not empty string
    if (!ctsLiveObject.hasOwnProperty([trainNo])) { // first time we receive data for this trainNo, or it was previously deleted due to train number change
        //console.log("CTS-trainnumber_first_time: " + msgObject.values.address);
        msgObject.values.firstTime = true;
        io.to(room).emit("cts_trainnumber_first_time", msgObject); // notify the client
        ctsLiveObject[trainNo] = [];
    }
    // insert this berth event first in the list of events for this train
    ctsLiveObject[trainNo].unshift(msgObject);

    // do not allow the berth event list to grow forever
    while (ctsLiveObject[trainNo].length > 200) {
        ctsLiveObject[trainNo].pop();
    } // keep max 420 newest cts values for each train, todo: use Redis and increase to last week or something

    // keep track of the berths that we have received data from, for debug
    ctsOKObject[CTS_toBerthObject.Name] = 1;

    io.to(room).emit(channel, [msgObject]); // pass on current train/berth as an array of 1 element

}; // parseandsendCTShistory ()

module.exports = function createRealTimeCTS (pio) {
    io = pio;
    return CTSRealTime;
};