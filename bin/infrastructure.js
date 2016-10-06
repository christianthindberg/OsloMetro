/**
 * Created by christianthindberg on 03/10/2016.
 */

"use strict";

// Read Infrastructure Definition
// Sort tracks, stations, berths etc
// API for retrieving Metro infrastructure data

const fs = require("fs");
const path = require("path");
const helpers = require("./helpers");

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
Infrastructure.isElement = function fNisElement (elementName) {
    if (!elementName) {
        return false;
    }
    return infraObject.hasOwnProperty(elementName);
};

// Berths
Infrastructure.getBerthTable = function () {
    return berthTable;
}; // getBerthTable()
Infrastructure.getNumBerths = function () {
    if (!berthTable || !Array.isArray(berthTable)) {
        return 0;
    }
    return berthTable.length;
}; // getNumBerths()

Infrastructure.isNewTrainNoOnBerth = function fNisNewTrainOnBerth (berthName, trainNo) {
    // check for valid inputs
    if (!isBerth(berthName) || !trainNo) {
        return false;
    }
    // if trainNumbers match it is obviously not a new train
    // also, if this is the first time we see a train on this berth (TrainNumber === 0) we define it as not a new train
    if (infraObject[berthName].TrainNumber === trainNo ||  infraObject[berthName].TrainNumber === 0) {
        return false;
    }
    return true;
};

Infrastructure.isNextBerth = function fNisNextBerth (fromBerthName, toBerthName) {
    if (!isBerth (fromBerthName) || !toBerthName) {
        return false;
    }
    return (infraObject[fromBerthName].nextitemCode === toBerthName);
};

Infrastructure.getNextBerth = function fNgetNextBerth (fromBerthName) {
    if (!isBerth(fromBerthName)) {
        return false;
    }
    return infraObject[fromBerthName].nextitemCode;
};

// Berth local
function isBerth (berthName) {
    if (!berthName || !infraObject.hasOwnProperty(berthName)) {
        return false;
    }
    return infraObject[berthName].itemTypeCode === "F";
}

// Various
Infrastructure.updateTrain = function fNupdateTrain (elemName, trainNo) {
    if (!Infrastructure.isElement(elemName) || !trainNo) {
        return false;
    }
    infraObject[elemName].TrainNumber = trainNo;
    return true;
}; // updateTrain()

Infrastructure.getLastTrainOnBerth = function fNgetLastTrain (fromBerthName) {
    if (!isBerth(fromBerthName)) {
        return 0;
    }
    return infraObject[fromBerthName].TrainNumber;
}; // getLastTrain()

Infrastructure.isUniqueLine = function fNisUniqueLine (elementName) {
    if (!Infrastructure.isElement(elementName)) {
        return false;
    }
    return infraObject[elementName].Lines.length === 1;
}; // isUniqueLine()

Infrastructure.getFirstLine = function fNgetFirstLine (elementName) {
    if (!Infrastructure.isElement(elementName) || !Array.isArray(infraObject[elementName].Lines)) {
        console.log ("Infrastructure: invalid args");
        return 0;
    }
    return infraObject[elementName].Lines[0];
}; // getFirstLine()

// Track switches
Infrastructure.getTrackSwitchTable = function () {
    return trackswitchTable;
}; // getTrackSwitchTable()

Infrastructure.getNumTrackSwitches = function () {
    if (!trackswitchTable || !Array.isArray(trackswitchTable)) {
        return 0;
    }
    return trackswitchTable.length;
}; // getNumTrackSwitches()

// End berths
Infrastructure.getEndBerthTable = function () {
    return endberthTable;
}; // getEndBerthTable()
Infrastructure.getNumEndBerths = function () {
    if (!endberthTable || !Array.isArray(endberthTable)) {
        return 0;
    }
    return endberthTable.length;
}; // getNumEndBerths()

// Stations
Infrastructure.getStationObject = function () {
    return stationObject;
}; // getStationObject()

Infrastructure.getNumStations = function () {
    if (!stationObject) {
        return 0;
    }
    if (!typeof stationObject === "object") {
        console.log ("Infrastructure error: station is not object");
        return 0;
    }
    return Object.keys(stationObject).length;
}; // getNumStations ()

Infrastructure.getStationByID = function fNfindStation (stationID) {
    let prop = null;
    if (!stationObject || typeof stationObject !== "object") {
        console.log("Infrastructure - no stations!");
        return null;
    }
    for (prop in stationObject) {
        if (stationObject.hasOwnProperty(prop) && stationObject[prop].CurrentStationID === stationID) {
                return stationObject[prop];
        }
    }
    if (stationID !== 6) { // known error: APC reports station 6 which is a non-existing station
        console.log("Infrastructure - Got non-existing station ID: " + stationID);
    }
    return null;
}; // getStationByID ()

// Tracks
Infrastructure.getTracksObject = function () {
    return tracksObject;
}; // getTracksObject()
Infrastructure.getNumTracks = function () {
    if (!tracksObject) {
        return 0;
    }
    if (!typeof tracksObject === "object") {
        console.log ("Infrastructure error: track is not object");
        return 0;
    }
    return Object.keys(tracksObject).length;
}; // getNumTracks()

// Infrastructure
Infrastructure.getInfraObject = function () {
    return infraObject;
}; // getInfraObject()
Infrastructure.getNumInfraElements = function () {
    if (!infraObject) {
        return 0;
    }
    if (!typeof infraObject === "object") {
        console.log ("Infrastructure error: infraObj is not object");
        return 0;
    }
    return Object.keys(infraObject).length;
}; // getNumInfraElements()


// Read data about all CTS positions and stations
Infrastructure.readMetroInfrastructure = function () {
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

function getTrackName (trackname) {
    return trackname.split(' ').join('_').replace("/", "_").replace("å", "a").replace("ø", "o").replace("æ", "ae");
} // getTrackName()

function calculateLines (infraObj) {
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