/**
 * Created by christianthindberg on 03/10/2016.
 *
 * Read Infrastructure Definition
 * Sort tracks, stations, berths etc
 * API for retrieving Metro infrastructure data
 *
 * Assert internal assumptions
 * do NOT assert
 * - Infrastructure Masterdata. The program must be robust against incorrect masterdata and process on a "best effort" basis
 * - CTS inputs. We do not have control of this input source, and inputs may change over time. Inconsistensies between CTS and Masterdata must be expected
 *
 * Todo: Enable logging of masterdata/CTS inconsistensies
 *
 * Note: Masterdata uses "itemCode", Driv/CTS uses "Name" for the same thing
 * In this module, as we are dealing with the masterdata we use "itemCode"
 *
 */

"use strict";


const fs = require("fs");
const path = require("path");
const helpers = require("./helpers");
const assert = require ("assert");
const logger = require('./logger');
const log = logger().getLogger('infrastructure');


//let stationTable = [];  // gps coordinates etc of the stations
let berthTable = [];  // gps coordinates etc for each berth ("sporfelt")
let trackswitchTable = []; // gps coordinates etc for each track switch ("sporveksel")
let endberthTable = []; // gps coordinates etc for "special" berths at the end of the tracks

let stationObject = {}; // same as stationTable, but "assosiative array", i.e. object with properties. Easier handling for parseAndSendCTS-function
let tracksObject = {}; // keep track of "Centrumsbanen", "Kolsåsbanen" etc
let infraObject = {}; // one property for each berth, switch etc holding the number of the train that last passed this element

let Infrastructure = {
    version: 1.0
};

// General Infrastructure
Infrastructure.isElement = function fNisElement (itemCode) {
    assert.ok(typeof itemCode === "string");
    return infraObject.hasOwnProperty(itemCode);
};

// Berth local
function isBerth (itemCode) {
    assert.ok(typeof itemCode === "string");

    if (!Infrastructure.isElement(itemCode)) {
        log.info("itemCode does not exist: " + itemCode);
        return false;
    }
    return infraObject[itemCode].itemtypeCode === "F";
}

function isStation (platformCode) {
    assert.ok(typeof platformCode === "string");
    if (!stationObject.hasOwnProperty(platformCode)) {
        // todo: log to Redis
        //log.info("isStation. platformCode does not exist: " + platformCode);
    }
    return stationObject.hasOwnProperty(platformCode);
}

// Berths
Infrastructure.getBerthTable = function () {
    assert.ok(Array.isArray(berthTable) && berthTable.length > 0);
    return berthTable;
}; // getBerthTable()

Infrastructure.getNumBerths = function () {
    assert.ok(Array.isArray(berthTable) && berthTable.length > 0);
    return berthTable.length;
}; // getNumBerths()

Infrastructure.isNewTrainNoOnBerth = function (berthName, trainNo) {
    assert.ok(typeof  berthName === "string");
    assert.ok(typeof  trainNo === "string");

    // check for valid inputs
    if (!isBerth(berthName)) {
        return false; // if trackswitch return false...
    }
    // if trainNumbers match it is obviously not a new train
    // also, if this is the first time we see a train on this berth (TrainNumber === 0) we define it as not a new train
    if (infraObject[berthName].TrainNumber === trainNo ||  infraObject[berthName].TrainNumber === 0) {
        return false;
    }
    return true;
};

Infrastructure.isNextBerth = function (fromItemCode, toBerthItemCode) {
    assert.ok(typeof fromItemCode === "string");
    assert.ok(typeof toBerthItemCode === "string");

    if (!Infrastructure.isElement(fromItemCode)) {
        // todo: save to Redis
        //log.info("Infrastructure.isNextBerth. Got non-existing fromItemCode: " + fromItemCode);
        return false;
    }
    if (!Infrastructure.isElement(toBerthItemCode)) {
        log.info("Infrastructure.isNextBerth. Got non-existing toberthItemCode: " + toBerthItemCode);
        return false;
    }

    return (infraObject[fromItemCode].nextitemCode === toBerthItemCode);
}; // isNextBerth ()

Infrastructure.getNextBerth = function (fromItemCode) {
    assert.ok (typeof fromItemCode === "string");

    if (!Infrastructure.isElement(fromItemCode)) {
        log.info
        return false;
    }
    assert.ok(infraObject.hasOwnProperty(fromItemCode));
    return infraObject[fromItemCode].nextitemCode;
};

// Various
Infrastructure.updateTrain = function (elemName, trainNo) {
    assert.ok(typeof elemName === "string");
    assert.ok(typeof trainNo === "string");
    //assert.ok(Infrastructure.isElement(elemName));

    infraObject[elemName].TrainNumber = trainNo;
}; // updateTrain()

Infrastructure.getLastTrainOnBerth = function (fromBerthName) {
    assert.ok(typeof fromBerthName === "string");
    assert.ok(isBerth(fromBerthName) === true);

    return infraObject[fromBerthName].TrainNumber;
}; // getLastTrain()

Infrastructure.isElementUniqueLine = function (itemCode) {
    assert.ok(typeof itemCode === "string");
    if (!Infrastructure.isElement(itemCode)) {
        log.info ("isElementUniqueLine. Got non-existing itemCode: " + itemCode);
        return false;
    }

    return infraObject[itemCode].Lines.length === 1;
}; // isElementUniqueLine()

Infrastructure.isStationUniqueLine = function (platformCode) { // ex AMM1
    assert.ok(typeof platformCode === "string");
    if (!isStation(platformCode)) {
        //log.info("Infrastructure.isStationUniqueLine. Got non-existing platformCode: " + platformCode);
        return false;
    }

    return stationObject[platformCode].Lines.length === 1;
}; // isStationUniqueLine()

Infrastructure.getElementFirstLine = function (elementName) {
    assert.ok(typeof elementName === "string");

    if (!Infrastructure.isElement(elementName)) {
        console.log("Infrastructure.getElementFirstLine. Got non-existing elementName: " + elementName);
        return false;
    }
    assert.ok(Array.isArray(infraObject[elementName].Lines));
    return infraObject[elementName].Lines[0];
}; // getBerthFirstLine()

Infrastructure.getStationFirstLine = function (platformCode) {
    assert.ok(typeof platformCode === "string");
    if (!isStation(platformCode)) {
        log.info("Got non-existing platformCode: " + platformCode);
        return 0;
    }
    assert.ok(Array.isArray(stationObject[platformCode].Lines));
    return stationObject[platformCode].Lines[0];
}; // getFirstLine()

// Track switches
Infrastructure.getTrackSwitchTable = function () {
    assert.ok(Array.isArray(trackswitchTable) && trackswitchTable.length > 0);

    return trackswitchTable;
}; // getTrackSwitchTable()

Infrastructure.getNumTrackSwitches = function () {
    assert.ok(Array.isArray(trackswitchTable) && trackswitchTable.length > 0);

    return trackswitchTable.length;
}; // getNumTrackSwitches()

// End berths
Infrastructure.getEndBerthTable = function () {
    assert.ok(Array.isArray(endberthTable) && endberthTable.length > 0);

    return endberthTable;
}; // getEndBerthTable()

Infrastructure.getNumEndBerths = function () {
    assert.ok(Array.isArray(endberthTable) && endberthTable.length > 0);

    return endberthTable.length;
}; // getNumEndBerths()

// Stations
Infrastructure.getStationObject = function () {
    assert.ok(typeof stationObject === "object");
    assert.ok(Object.keys(stationObject).length > 0);
    return stationObject;
}; // getStationObject()

Infrastructure.getNumStations = function () {
    assert.ok(typeof stationObject === "object");
    assert.ok(Object.keys(stationObject).length > 0);
    return Object.keys(stationObject).length;
}; // getNumStations ()

Infrastructure.getStationByID = function (stationID) {
    assert.ok(typeof stationID === "number", "Infrastructure.getStationByID. Invalid parameter: " + stationID);
    assert.ok(typeof stationObject === "object");
    assert.ok(Object.keys(stationObject).length > 0);

    let prop = null;

    for (prop in stationObject) {
        if (stationObject.hasOwnProperty(prop) && stationObject[prop].CurrentStationID === stationID) {
                return stationObject[prop];
        }
    }
    if (stationID !== 6) { // known error: APC reports station 6 which is a non-existing station
        log.info("Infrastructure - Got non-existing station ID: " + stationID);
    }
    return null;
}; // getStationByID ()

// Tracks
Infrastructure.getTracksObject = function () {
    assert.ok(typeof tracksObject === "object");
    assert.ok(Object.keys(tracksObject).length > 0);
    return tracksObject;
}; // getTracksObject()
Infrastructure.getNumTracks = function () {
    assert.ok(typeof tracksObject === "object");
    assert.ok(Object.keys(tracksObject).length > 0);
    return Object.keys(tracksObject).length;
}; // getNumTracks()

// Infrastructure
Infrastructure.getInfraObject = function () {
    assert.ok(typeof infraObject === "object");
    assert.ok(Object.keys(infraObject).length > 0);
    return infraObject;
}; // getInfraObject()

Infrastructure.getNumInfraElements = function () {
    assert.ok(typeof infraObject === "object");
    assert.ok(Object.keys(infraObject).length > 0);
    return Object.keys(infraObject).length;
}; // getNumInfraElements()

/**
 * readMetroInfrastructure ()
 * Read data about all CTS positions and stations
 * 
 * berthTable = [];  // gps coordinates etc for each berth ("sporfelt")
 * trackswitchTable = []; // gps coordinates etc for each track switch ("sporveksel")
 * endberthTable = []; // gps coordinates etc for "special" berths at the end of the tracks
 * stationObject = {}; // same as stationTable, but "assosiative array", i.e. object with properties. Easier handling for parseAndSendCTS-function
 * tracksObject = {}; // keep track of "Centrumsbanen", "Kolsåsbanen" etc
 * infraObject = {}; // All elements in the infrastructure
 */

Infrastructure.readMetroInfrastructure = function () {
    // todo: add filename checking, permissions etc
    let fileContents = fs.readFileSync(path.join(__dirname, "sporfelt.csv"));
    let fileLines = fileContents.toString().split('\n');
    let track = null;
    let tmpTracksObject = {}; // "associative" array containing Centrumsbanen[178], Kolsasbaanen194], ...
    let tmpInfraTable = []; // all elements in infrastructure, i.e. stations, track switches, berths, .
    let tmpStationTable = [];
    let i = 0;

    //Sporfeltkode	Sporfeltnavn	Banekode	Banenavn	Retning	NesteSporfeltkode	StartposisjonBreddegrad	StartposisjonLengdegrad
    //SluttposisjonBreddegrad	SluttposisjonLengdegrad	MeterFraNullpunkt	Sporfeltstypekode	Sporfeltstypenavn
    //KildekodeCTSBERTH	MeterLengde	Plattformkode	Stasjonskode	Stasjonsnavn	PlattformposisjonBreddegrad	PlattformposisjonLengdegrad PIDAS

    for (i = 1; i < fileLines.length; i++) {        //start from 1 to skip header row
        let items = fileLines[i].toString().split(";");
        let infraObj = {
            itemCode: items[0], // C0231T
            itemName: items[1], // C-Spor3
            trackCode: items[2], // M
            trackName: items[3], // Majorstuen driftsområde
            trackDirectionName: items[4], // Østover
            trackDirectionCode: 0,  // calculated below
            nextitemCode: items[5], // K635
            Startlat: parseFloat(items[6], 10), // 59.928913
            Startlng: parseFloat(items[7], 10), // 10.649478
            Stoplat: parseFloat(items[8], 10), // ...
            Stoplng: parseFloat(items[9], 10), // ...
            MetersFromZero: parseFloat(items[10], 10), // 3291.8950, meters from Nationaltheatret station
            itemtypeCode: items[11], // F(elt), E(nde), V(eksel)
            itemtypeName: items[12], // O1424W
            sourceCTSBERTH: items[13], // K655, name used by the signalling system
            meterLength: parseFloat(items[14], 10), // 202.7920, lenght of this Sporfelt
            platformCode: items[15], // AMM2, NULL if not station
            stationCode: items[16], // AMM, null if not station
            stationName: items[17], // Ammerud
            platformlat: parseFloat(items[18], 10), // lat
            platformlng: parseFloat(items[19], 10), // lng
            CurrentStationID: parseInt(items[20], 10), // PIDAS ID
            TrainNumber: 0 // The train that was last passing onto this infrastructure object
        };
        infraObj.trackDirectionCode = infraObj.trackDirectionName === "Vestover" ? 1 : -1; // easier visualization code.. see driver.jade
        infraObj.Lines = calculateLines(infraObj);
        tmpInfraTable.push(infraObj);
        if (infraObj.stationCode) {
            let t = infraObj;
        }
        infraObject[infraObj.itemCode] = infraObj; //infraObj; // during operation the value will be set to the number of the train that passed most recently

        // Build tmp object that has a property for each trackname. The property holds an array of all berth elements for that trackname
        if (infraObj.trackName === null || infraObj.trackName === undefined || infraObj.trackName === "NULL")
            break;

        let tn = getTrackName(infraObj.trackName); // remove spaces, "/", æøå from .trackname
        if (!tmpTracksObject[tn]) {
            tmpTracksObject[tn] = [];
        }
        tmpTracksObject[tn].push(infraObj);
    } // for-loop

    // Finalize bulding global tracksObject
    // split east and west, sort west descending, east ascending, remove items without sourceCTSBERTH/MetersFromZero/lat/lng,
    // add the arrays together and then we have a track that can be drawn from west to east
    for (track in tmpTracksObject) {
        let west = tmpTracksObject[track].filter(function (obj) {
            return obj.trackDirectionName === "Vestover" && obj.sourceCTSBERTH !== "NULL" && obj.sourceCTSBERTH && helpers.MyIsNumber(parseFloat(obj.MetersFromZero)) &&
                helpers.MyIsNumber(parseFloat(obj.Startlat)) && helpers.MyIsNumber(parseFloat(obj.Startlng)) &&
                obj.itemtypeCode !== "V";
        }) // exclude the track switches, they seem to mess up the track paths
        // Descending
            .sort(function (a, b) {
                return b.MetersFromZero - a.MetersFromZero;
            });

        let east = tmpTracksObject[track].filter(function (obj) {
            return obj.trackDirectionName !== "Vestover" && obj.sourceCTSBERTH !== "NULL" && obj.sourceCTSBERTH && helpers.MyIsNumber(parseFloat(obj.MetersFromZero)) &&
                helpers.MyIsNumber(parseFloat(obj.Startlat)) && helpers.MyIsNumber(parseFloat(obj.Startlng)) &&
                obj.itemtypeCode !== "V";
        }) // exclude the track switches...
        // Ascending
            .sort(function (a, b) {
                return a.MetersFromZero - b.MetersFromZero;
            });

        // Finally, add tracks to the global tracksObject
        if (west.length > 0 || east.length > 0) {
            tracksObject[track + "-west"] = west;
            tracksObject[track + "-east"] = east;
        }
    }
    // split data into the letious elements (stations, berths, trackswitches...)
    tmpStationTable = tmpInfraTable
        .filter(function (obj) {
            return obj && obj.stationName && obj.stationName !== "NULL" && helpers.MyIsNumber(parseFloat(obj.platformlat)) && helpers.MyIsNumber(parseFloat(obj.platformlng));
        })
        .sort(function (a, b) {
            return a.CurrentStationID - b.CurrentStationID;
        });
    for (i = 0; i < tmpStationTable.length; i++) {
        stationObject[tmpStationTable[i].platformCode] = tmpStationTable[i];
        // sanity check
        if (!tmpStationTable[i].platformlat || !tmpStationTable[i].platformlng || tmpStationTable[i].platformlat > 60 || tmpStationTable[i].platformlat < 59 || tmpStationTable[i].platformlng > 11 || tmpStationTable[i].platformlng < 10)
            console.log("Index: " + i + " lat: " + tmpStationTable[i].platformlat + " long: " + tmpStationTable[i].platformlng);
    }
    trackswitchTable = tmpInfraTable.filter(function (obj) {
        return obj && obj.itemtypeCode === "V" && obj.sourceCTSBERTH && obj.sourceCTSBERTH !== "NULL" && helpers.MyIsNumber(parseFloat(obj.Startlat)) && helpers.MyIsNumber(parseFloat(obj.Startlng));
    });
    berthTable = tmpInfraTable.filter(function (obj) {
        return obj && obj.itemtypeCode === "F" && obj.sourceCTSBERTH && obj.sourceCTSBERTH !== "NULL" && helpers.MyIsNumber(parseFloat(obj.Startlat)) && helpers.MyIsNumber(parseFloat(obj.Startlng));
    });
    endberthTable = tmpInfraTable.filter(function (obj) {
        return obj && obj.itemtypeCode === "E" && helpers.MyIsNumber(parseFloat(obj.Startlat)) && helpers.MyIsNumber(parseFloat(obj.Startlng));
    }); // todo: sourceCTSBERTH is "", this is an error in the master data
}; // readMetroInfrastructure ()

function getTrackName (trackname) { // todo: use regex instead of replace
    return trackname.split(' ').join('_').replace("/", "_").replace("å", "a").replace("ø", "o").replace("æ", "ae");
} // getTrackName()

function calculateLines (infraObj) {
    assert.ok(typeof infraObj === "object");
    assert.ok(infraObj.hasOwnProperty("trackCode"));

    switch (infraObj.trackCode) {
        case "H":
            return [1];
        case "R": // Røabanen
        case "F": // Furusetbanen
            return [2];
        case "K":
            return [3];
        case "L": // Lambertseterbanen
            return [4, 5];
        case "S":
            return [5];
        case "G":
            if (infraObj.MetersFromZero < 5500) // Grorudbanen, stations Carl Berner and Hasle are unique to line 5
                return [5];  //
            return [4, 5];
        case "D": // Lørenbanen
            return [4];
        case "C":
            return [1, 2, 3, 4, 5]; // todo: add check to differentiate "fellestunnelen" which serves all lines from the parts of centrumsbanen only serving line 4 and 5
        case "Ø":
            if (infraObj.MetersFromZero > 6600)
                return [3];
            return [1, 2, 3, 4]; // around Brynseng
        default:
            return [1, 2, 3, 4, 5]; // not able to determine line, could be any
    } // case
} // calculateLines ()

module.exports = Infrastructure;