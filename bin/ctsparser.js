/**
 * Created by christianthindberg on 15/10/2016.
 */

/*
 * Parse incoming CTS Events
 * Store events and emit to clients
 *
 * Parsing: event data is received in an msgObject
 *      - is the msgObject valid?
 *      - is it a ghost event (i.e. a "undefined" signal from the CTS
 *      - has a train changed its logical number
 *      - is it a maintenance train?
 *      - is the event a special CTS code f.ex indicating that the train has parked or exited the cts-system?
 *      - identify the line the train is servicing
 *          to do this we also need to keep track of the last berth the train has been on that was unique to a line
 *
 *
 *  CTSRealTime.parseAndSendCTS
 *      function checkTrainNoChange
 *      function isValidFromBerth
 *      function isValidToBerth
 *      function saveNormalCTSEvent
 *      function IsGhostTrain
 *      function updateTrainNoChangeSuspects(trainNo, timestampString)
 *      function getBerthName (msgObject)
 *      function isSpecialCTSCode (code)
 *      function IsYellowTrain (trainNo)
 *      function getLastUniqueLine (msgObject)
 *      function guessLine (msgObject)
 *      function guessLineNoFromTrainNo (trainNo)
 *      function trainChangeNumber (oldTrainNo)
 *      function logDisorder (on, timestamp)
 *      updateLastEventFromTrain (msgObject)
 *
 */

/* Format av the message we receive on topic "cts"
 {
 "topic" : "cts",
 "values" :
    {   "from_infra_berth" :
        {   "Name"      : "R0852T",
            "Latitude"  : 59.94284,
            "Longitude" : 10.618624
        },
        "to_infra_berth" :
        {   "Name"      : "R0878T",
            "Latitude"  : 59.941393,
            "Longitude" : 10.616812
        },
        "time_stamp"    : "2016-03-20T11:23:05Z",
        "sequence_no"   : 0,
        "interlocking_id" : "OST",
        "from_berth"    : "R852 ",
        "to_berth"      : "R878 ",
        "address"       : "508",
        "path"          : "0111",
        "destination"   : "ØSÅ2",
        "delay"         : -82,
        "arrive_depart" : " ",
        "platform"      : " ",
        "ars_mode"      : "T",
        "metadata"      :
        {   "dataType"    : "tuv",
            "dataMock" : false,
            "isSafeFromDelete" : false,
            "dataPartition" : "tuv-2016-03-20-508",
            "entryAssembly" : null,
            "operatingDayOslo" : "2016-03-20",
            "drivTimeStamp" : "2016-03-20T11:23:15.9189806Z"
        }
    }
 }
 */

"use strict";

const infrastructure = require("./infrastructure");
const helpers = require("./helpers");
const opstore = require("./opstore");
const assert = require("assert");
const logger = require("./logger");
const log = logger().getLogger("ctsparser");

let ctstrainChangeSuspectObject = {}; // trains we believe have changed their logical number
let lastEventFromTrainObject = {}; // holds one attribute for each live trainNo. Each attribute holds the last cts event received

let destinationObject = {}; // for debug, all destinations received from the trains
let missingToBerths = {};
let missingFromBerths = {};
let trainChangeNoBerths = {};
let specialBerths = {};
let trainNumbers = {};

let fnEventCallback = null;

let CTSParser = {
    version: 1.0
};


/**
 *
 * @param msgObject: event sent from CTS via Driv
 *
 * events arrive out of order and it happens that same event arrives several times
 * events such as a train changing its logical number are not reported by CTS
 * events do not contain information on which Line the train is servicing
 * event properties contain spaces. These are removed
 * trains sometimes "jump" i.e. they do not move according to the infrastructure masterdata
 *
 * parseAndSendCTS calculate "missing" events (i.e. trainChange) and add "missing" information.
 *
 * The following data is always added to an event during parsing:
 * msgObject.values.event =
 *  "ghost"     : received a fake signal from cts (i.e. trainNumber === "----"
 *  "special"   : msgObject.values.to_berth || from_berth === INTERP, EXIT, NOTD, ...
 *  "noto"      : if to berth is not matched with infrastructure masterdata
 *  "trnochg    : we have discovered that the train changed its number.
 *                  In this case also msgObject.newTrainNo is set
 *  "event"     : normal event
 *
 * msgObject.values.lastUniqueLine      - the number of the line the train was on last time it was on a unique part of the tracks
 * msgObject.values.Line                - the number of the Line we decide the train is currently servicing
 *
 * The following data _may_ be added to an event during parsing:
 * msgObject.values.isYellow            - true if we find that cts is from a maintenance train
 * msgObject.values.isTrainJump         - true if current berth !== previousBerth.nextBerth
 *      in this case also the following values are set: jump_ctsFrom, jump_ctsTo, jump_infraTo
 *
 */
CTSParser.parseAndSendCTS = function (msgObject) {
    let trainNo = 0;
    let timestamp = null;
    let isValidTo = false;
    let isValidFrom = false;

    msgObject = helpers.removeSpaces(msgObject);

    if (!isValidMsgObject(msgObject)) {
        log.error("parseAndSendCTS. Received invalid msgObject: " + JSON.stringify(msgObject, undefined, 2));
        return null;
    }

    trainNo = msgObject.values.address;
    timestamp = new Date(msgObject.values.time_stamp).getTime();

    logDisorder(false, timestamp); // set to true for a simple check of events arriving in increasing time. Logs out-of-order to console

    // There is no guarantee that CTSevents arrive in strict order, or that events arrive only once
    // Whenever a change of a train number is suspected, we keep the trains on a "suspect list" for a short while
    updateTrainNoChangeSuspects(trainNo, msgObject.values.time_stamp);

    isValidFrom = isValidFromBerth (msgObject);
    isValidTo = isValidToBerth(msgObject);

    if (IsGhostTrain(trainNo)) {
        msgObject.values.event = "ghost";
        return msgObject;
    }

    if (IsYellowTrain(trainNo)) {
        msgObject.values.isYellow = true;
    }

    // Special CTS code?
    if (isSpecialCTSCode(msgObject.values.to_berth) || isSpecialCTSCode(msgObject.values.from_berth)) {
        msgObject.values.event = "special";
        return msgObject;
    }

    if (!isValidTo) {
        msgObject.event = "noto";
        return msgObject;
    }

    if (isValidFrom) {
        checkTrainNoChange(msgObject); // check if our train changed its number from the last time we heard from it and to now
    }

    // register that the current train arrived at this toBerth
    infrastructure.updateTrain(msgObject.values.to_infra_berth.Name, trainNo);

    msgObject.values.lastUniqueLine = getLastUniqueLine (msgObject);
    msgObject.values.Line = guessLine (msgObject);

    updateLastEventFromTrain(msgObject);

    msgObject.values.event = "event"; // normal cts event
    return msgObject;
}; // parseandsendCTS ()

function updateTrainNoChangeSuspects(trainNo, timestampString) {
    assert(typeof trainNo === "string", "Invalid trainNo: " + trainNo);
    assert(typeof timestampString === "string", "Invalid timestampString: " + timestampString);
    if (ctstrainChangeSuspectObject.hasOwnProperty(trainNo)) { // train did not change number since we are still getting data from it
        ctstrainChangeSuspectObject[trainNo].countCTSMsg += 1;
        log.info ("updateTrainNoChangeSuspects. Received event from suspect train number: " + trainNo + ". Received events: " + ctstrainChangeSuspectObject[trainNo].countCTSMsg + " Timestamp: " + timestampString);
    }
} // updateTrainNoChangeSuspects()

function checkTrainNoChange (msgObject) {
    assert(typeof msgObject === "object");
    // at this point, we can assume that we have a valid to_infra berth and from_infra_berth
    assert(msgObject.hasOwnProperty("values"));
    assert(msgObject.values.hasOwnProperty("to_infra_berth"));
    assert(msgObject.values.hasOwnProperty("from_infra_berth"));

    const fromBerthName = msgObject.values.from_infra_berth.Name;
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
                log.info("checkTrainNoChange. Suspected train number change was already registered. Train No: " + oldTrainNo + " New TrainNo: " + trainNo + ". Timestamp: " + msgObject.values.time_stamp);
            }
            else {
                log.info("checkTrainNoChange. Adding train to suspects. Old Train No: " + oldTrainNo + " New Train No: " + trainNo + ". Timestamp: " + msgObject.values.time_stamp);
                ctstrainChangeSuspectObject[oldTrainNo] = { "oldTrainNo": oldTrainNo, "newTrainNo": trainNo, "countCTSMsg": 0, "msgObject": msgObject};
                setTimeout(trainChangeNumber, 30*1000, oldTrainNo);
            }
        }
        else { // CTS and masterdata do not match Save:opstore....
            log.warn("checkTrainNoChange. Berth mismatch. Expected from: " + fromBerthName + " Infrastructure-to: " +  infrastructure.getNextBerth(fromBerthName) + " CTS-to: " + toBerthName);
            msgObject.isTrainJump = true;
            msgObject.values.jump_ctsFrom = fromBerthName;
            msgObject.values.jump_ctsTo = toBerthName;
            msgObject.values.jump_infraTo = infrastructure.getNextBerth(fromBerthName);
            //saveCTSEvent(msgObject);
        }
    } // new train on berth
} // checkTrainNoChange()

function trainChangeNumber (oldTrainNo) {
    let newTrainNo = -1;
    let msgObject = null;

    assert(typeof oldTrainNo === "string");
    assert(ctstrainChangeSuspectObject.hasOwnProperty(oldTrainNo));

    newTrainNo = ctstrainChangeSuspectObject[oldTrainNo].newTrainNo;
    msgObject = ctstrainChangeSuspectObject[oldTrainNo].msgObject;
    log.info("trainChangeNumber. oldTrainNo: " + oldTrainNo + " newTrainNo: " + newTrainNo + " extra messages received: " + ctstrainChangeSuspectObject[oldTrainNo].countCTSMsg);


    assert(typeof newTrainNo === "string");
    assert(typeof msgObject === "object");

    if (ctstrainChangeSuspectObject[oldTrainNo].countCTSMsg > 0) {
        // we have received messages relating to the old trainNumber after we thought it had changed
        // Check how lang ago it is...
        if (!lastEventFromTrainObject.hasOwnProperty(oldTrainNo)) {
            log.error ("Old train no: " + oldTrainNo + " was already deleted");
            return; // old train number object already deleted. This may happen if we receive the same CTS-message several times (?? is this true?)
        }

        let ctsEventTime = new Date(lastEventFromTrainObject[oldTrainNo].values.time_stamp).getTime();
        let dateNow = Date.now(); // todo: fix to work even with playback
        if (dateNow - ctsEventTime < 20000) {  // received last event less than 20 secunds ago -> no train number change occured
            delete ctstrainChangeSuspectObject[oldTrainNo]; // Not suspected anymore because there was _no_ change
            log.info("trainChangeNumber. No change of train number had occured. Train change no longer suspected for train: " + oldTrainNo);
            return; // train change had not happened
        }
    }

    // Train-number change occured...

    if (lastEventFromTrainObject.hasOwnProperty(oldTrainNo)) {  // sometimes CTS sends same message twice, this is to avoid crashing the second time around...
        delete lastEventFromTrainObject[oldTrainNo];
        log.info("trainChangeNumber. lastEventFromTrainObject[" + oldTrainNo + "] deleted");
        helpers.incProperty(trainChangeNoBerths, getBerthName(msgObject)); // for debugging - log the from_berth that had trainNumber different from current trainNumber ("address")
    }
    else {
        log.warn("trainChangeNumber. No entry for lastEventFromTrainObject[" + oldTrainNo + "]");
    }
    // delete from suspectList
    delete ctstrainChangeSuspectObject[oldTrainNo];
    log.info("trainChangeNumber. CTS-trainnumber_changed. Oldnumber: " + oldTrainNo + " New number: " + newTrainNo + " msgObject.values.destination: " + msgObject.values.destination);
    msgObject.newTrainNo = newTrainNo;
    msgObject.values.event = "trnochg";
    if (!fnEventCallback) {
        console.error("trainChangeNumber. Callback not defined");
        return;
    }
    fnEventCallback(msgObject);
} //trainChangeNumber()

function isValidMsgObject (msgObject) {
    if (typeof msgObject !== "object")
        return false;
    if (typeof msgObject.topic !== "string")
        return false;
    if (typeof msgObject.values !== "object")
        return false;
    if (typeof msgObject.values.time_stamp !== "string")
        return false;
    if (typeof msgObject.values.address !== "string")
        return false;
    return true;
} // isValidMsgObject

function isValidFromBerth (msgObject) {
    assert (typeof msgObject === "object");

    if (!msgObject.values.from_infra_berth) { // this is a valid case, (f.ex entering from Ryen? or receiving special CTS-code like INTERP, CANCEL, LOST, EXIT
        helpers.incProperty(missingFromBerths, msgObject.values.from_berth); // for debugging - log that we encountered from-berth that was not matched
        return false;
    }
    if (!msgObject.values.from_infra_berth.Name) {
        log.warn("isValidFromBerth. Got non-existing from_infra_berth.Name: " + msgObject.values.from_berth);
        return false;
    }
    if (!infrastructure.isElement(msgObject.values.from_infra_berth.Name)) {
        log.warn("isValidFromBerth. invalid from_infra_berth.Name: " + msgObject.values.from_infra_berth.Name);
        return false;
    }
    return true;
} // isValidFromBerth()

function isValidToBerth (msgObject) {
    assert (typeof  msgObject === "object");

    if (!msgObject.values.to_infra_berth) {
        helpers.incProperty(missingToBerths, msgObject.values.to_berth); // for debugging - log that we encountered to-berth that was not matched
        //log.warn("parseAndSendCTS. msgObject did not contain to_infra_berth: " + JSON.stringify(msgObject, undefined, 2));
        //saveInvalidCTSEvent(msgObject);
        return false; // not going anywhere, just return
    }

    if (!infrastructure.isElement(msgObject.values.to_infra_berth.Name)) { // Invalid berth?
        log.warn("isValidToBerth. Got non-existing to_infra_berth.Name: " + msgObject.values.to_berth);
        //todo: helpers.incProperty invalid berth...
        //saveUnknownBerthCTSEvent(msgObject);
        return false; // not going anywhere we know of, ...
    }
    return true;
} // isValidToBerth()


// Train is considered to be a "ghost" train/false signal if
// trainNo do not contain any alphanumeric characters.
// False signals typically have trainNo "----"
function IsGhostTrain (trainNo) {
    assert(typeof trainNo === "string");

    return !trainNo.match(/[0-9a-z*]/gi);
} // IsGhostTrain ()

/**
 * Small helper function used by parseAndStoreGhostObject and trainChangeNumber
 * Gets the "best" berth name to associate with an event
 * 1. to_infra_berth.Name
 * 2. from_infra_berth.Name
 * 3. from_berth
 * 4. to_berth
 * @param msgObject
 * @returns {name of berth}
 */
function getBerthName (msgObject) {
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
function IsYellowTrain (trainNo) {
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
 * function guessLine
 *
 * @param msgObject
 * @returns the number of the line that the train is most probably servicing. 0 if unable to guess
 *
 * The concept of Lines is used to inform passengers about the end-stations assosiated with a certain train-movement.
 * In reality, there are exceptions from this simple concept and the signalling system do not report which line is associated with a train
 * We deduct line as follows
 * 1. Look at the destination. Bergkrystallen may be line 1 or 4, Vestli may be line 4 or 5. Destination may also be Majorstua or any other station that could be any line
 *      if Destination is unique such as Sognsvann (line 5) we use this
 * 2. Look at where the train has been. Find the last berth it passed that is associated with only 1 line
 * 3. If train has not been at a "one-line-only" berth, look at the train-number. For 3-digit trainnumbers the first digit is normally the line
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

/**
 * function getLastUniqueLine
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
    // Has the train been on a berth that was unique to 1 line?
    if (lastEventFromTrainObject.hasOwnProperty(trainNo)) {
        return lastEventFromTrainObject[trainNo].values.lastUniqueLine;
    }
    return 0;
} // getLastUniqueLine()

/**
 * function guessLineFromTrainNo
 * @param trainNo
 * @returns the Line number the train is probably servicing, based on the logical train number
 *
 *  Trains numbered 17xx and 13xx are trams,
 *  *01 and similar are normal trains but CTS has "lost" its original number,
 *  3-digit trainnumbers are normal and in most cases the first digit is equal to the line
 *
 */
function guessLineNoFromTrainNo (trainNo) {
    let tmpLine = 0;
    assert (typeof trainNo === "string");

    tmpLine = parseInt(trainNo.replace(/[a-z*]/gi, "")); // remove characters and "*"
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

function updateLastEventFromTrain (msgObject) {
    let trainNo = null;
    assert (typeof msgObject === "object");

    trainNo = msgObject.values.address;

    if (!lastEventFromTrainObject.hasOwnProperty([trainNo])) { // first time we receive data for this trainNo, or it was previously deleted due to train number change
        //console.log("CTS-trainnumber_first_time: " + msgObject.values.address);
        msgObject.values.firstTime = true;
    }
    lastEventFromTrainObject[trainNo] = msgObject;
} // updateLastEventFromTrain()

module.exports = function (callback) {
    assert (typeof callback === "function");
    fnEventCallback = callback;
    return CTSParser;
}