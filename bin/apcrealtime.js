/**
 * Created by christianthindberg on 04/10/2016.
 */

// APC - Automatic Passenger Counting
//

"use strict";
const infrastructure = require("./infrastructure");
const assert = require("assert");
const logger = require('./logger');
const log = logger().getLogger('apcrealtime');

let io = null;

let passengerTable = [];
let sumPerLineTable = [];
let sumPerStationTable = [];
let sumPerOwnModuleTable = [];
let APCObject = {}; // Automated Passenger Counting, i.e. physical id for each 3-car train set, and other data from the onboard PIDAS-system

let APC = {};

APC.getAPCObject = function () {
    return APCObject;
};
// Passengers
APC.getPassengerTable = function () {
    return passengerTable;
}; // getPassengerTable()

APC.hasPassengers = function () {
    if (!passengerTable || ! Array.isArray(passengerTable)) {
        return false;
    }
    return passengerTable.length > 0;
}; // hasPassengers()

// sumPerLine
APC.getSumPerLineTable = function () {
    return sumPerLineTable;
}; // getSumPerLineTable()

APC.hasSumPerLine = function () {
    if (!sumPerLineTable || ! Array.isArray(sumPerLineTable)) {
        return false;
    }
    return sumPerLineTable.length > 0;
}; // hasSumPerLine()

// sumPerStation
APC.getSumPerStationTable = function () {
return sumPerStationTable;
}; // getSumPerStationTable()

APC.hasSumPerStation = function () {
    if (!sumPerStationTable || ! Array.isArray(sumPerStationTable)) {
        return false;
    }
    return sumPerStationTable.length > 0;
}; // hasSumPerStation()

// sumPerOwnModule
APC.getSumPerOwnModuleTable = function () {
    return sumPerOwnModuleTable;
}; // getSumPerOwnModuleTable()

APC.hasSumPerOwnModule = function () {
    if (!sumPerOwnModuleTable || ! Array.isArray(sumPerOwnModuleTable)) {
        return false;
    }
    return sumPerOwnModuleTable.length > 0;
}; // hasSumPerOwnModule()

// Parsers
APC.parseSumPerLine = function (room, channel, msgObject) {
    let lineObj = null;
    let i = 0;

    assert(typeof room === "string");
    assert(typeof channel === "string");
    assert(typeof msgObject === "object");

    if (!msgObject.values || !Array.isArray(msgObject.values)) {
        log.warn("parseSumPerLine - invalid msgObject: " + JSON.stringify(msgObject, undefined, 2));
        return;
    }
    if (msgObject.values.length > 0) {
        sumPerLineTable = [];
    }

    for (i = 0; i < msgObject.values.length; i+=1) {
        lineObj = JSON.parse(msgObject.values[i]);
        sumPerLineTable.push({
            "LineNumber": lineObj.LineNumber,
            "TotalBoarding": lineObj["sum(TotalBoarding)"],
            "TotalAlighting": lineObj["sum(TotalAlighting)"]
        });
    }
    io.to(room).emit(channel, sumPerLineTable);
}; // parseSumPerLine()

APC.parseSumPerStation = function (room, channel, msgObject) {
    let stationObj = null;
    let i = 0;

    assert(typeof room === "string");
    assert(typeof channel === "string");
    assert(typeof msgObject === "object");

    if (!msgObject.values || !Array.isArray(msgObject.values)) {
        log.warn("parseSumPerStation - invalid msgObject: " + JSON.stringify(msgObject, undefined, 2));
        return;
    }
    if (msgObject.values.length > 0) {
        sumPerStationTable = [];
    }
    for (i = 0; i < msgObject.values.length; i+=1) {
        stationObj = JSON.parse(msgObject.values[i]);
        sumPerStationTable.push({
            "CurrentStationID": stationObj.CurrentStationID,
            "TotalBoarding": stationObj["sum(TotalBoarding)"],
            "TotalAlighting": stationObj["sum(TotalAlighting)"]
        });
    }
    io.to(room).emit(channel, sumPerStationTable);
}; // parseSumPerStation ()

APC.parseSumPerOwnModule = function (room, channel, msgObject) {
    let OwnModuleObj = null;
    let i = 0;

    assert(typeof room === "string");
    assert(typeof channel === "string");
    assert(typeof msgObject === "object");

    if (!msgObject.values || !Array.isArray(msgObject.values)) {
        log.warn("parseSumPerOwnModule - invalid msgObject: " + JSON.stringify(msgObject, undefined, 2));
        return;
    }

    if (msgObject.values.length > 0) {
        sumPerOwnModuleTable = [];
    }
    for (i = 0; i < msgObject.values.length; i+=1) {
        OwnModuleObj = JSON.parse(msgObject.values[i]);
        sumPerOwnModuleTable.push({
            "OwnModuleNo": OwnModuleObj.OwnModuleNo,
            "TotalBoarding": OwnModuleObj.Boarding,
            "TotalAlighting": OwnModuleObj.Alighting
        });
    }
    io.to(room).emit(channel, sumPerOwnModuleTable);
}; // parseSumPerOwnModule ()

APC.parsePassengerData = function (room, channel, msgObject) {
    // The PIDAS also sends useful information about the trains. Keep track of updated trains info also
    let tmpAPCObject = {};
    let tmpPassengerTable = [];
    let records = null;
    let bStationFound = false;
    let i = 0;
    let station = null;

    assert(typeof room === "string");
    assert(typeof channel === "string");
    assert(typeof msgObject === "object");

    if (!msgObject.values) {
        log.info("parsePassengerData - invalid msgObject: " + JSON.stringify(msgObject, undefined, 2));
        return;
    }

    records = msgObject.values.toString().split("\n");

    if (records === null || records === undefined || records.length === 0) { // we did NOT receive data
        log.warn("parsePassengerData - msgObject did not contain data: " + JSON.stringify(msgObject));
        return;
    }

    //passengerTable = []; // throw away the old data
    // todo: implement structure to keep track of N last data, should utilize Redis for that

    for (i = 0; i < records.length; i += 1) {
        let items = records[i].toString().split(";");
        let passengerObject = null;
        if (items && items.length === 1 && items[0] === "" && i === records.length - 1) {
            break; // seems all passenger files contains an empty record at the end - just ignore it
        }
        if (!items || items.length < 15) { // at present there will be 70 items in a record, but this may change in the future. We assume that the first 15 will stay unchanged
            log.error("parsePassengerData - msgObject contained invalid data. Record " + i + " of " + records.length + ": " + records[i] + " msgObject: " + JSON.stringify(msgObject) + " room: " + room + " channel: " + channel);
            return;  // replace with continue?
        }

        passengerObject = {
            DateAndTimeUnix: parseInt(items[0], 10) * 1000, // time in milliseconds
            TogNumber: parseInt(items[1], 10),
            OwnModuleNo: parseInt(items[2], 10),
            CoupledModuleNo: parseInt(items[3], 10),
            ModuleConfig: parseInt(items[4], 10),
            LeadingOrGuided: parseInt(items[5], 10),
            TotalBoarding: parseInt(items[6], 10),
            TotalAlighting: parseInt(items[7], 10),
            CurrentStationID: parseInt(items[8], 10),
            RouteCodeID: parseInt(items[9], 10),
            LineNumber: parseInt(items[10], 10),
            StartStationID: parseInt(items[11], 10),
            EndStationID: parseInt(items[12], 10),
            SensorDiagnoseError: parseInt(items[13], 10),
            DataInvalid: parseInt(items[14], 10),
            DateAndTimeUnixDataReceived: 0
        };
        passengerObject.DateAndTimeUnixDataReceived = Date.now();
        // An undocumented "feature" of the Siemens PIDAS system is that it sometimes adds 500 to the PIDAS_ID/CurrentStationID
        // This is believed to occur if the train pass a station for the second time wihout having been able to upload the data from the previous pass
        if (passengerObject.CurrentStationID > 500) {
            passengerObject.CurrentStationID -= 500;
        }

        // find info about the station corresponding to PIDAS_ID
        let stationObject = infrastructure.getStationByID(passengerObject.CurrentStationID);
        if (!stationObject) {
            if (passengerObject.CurrentStationID !== 6) { // station 6 is non-existing, APC bug...
                log.error("apcrealtime - Station not found!");
            }
        }
        else {
            setLastPaxUpdateTime(passengerObject.DateAndTimeUnix);
            // Merge together passengerData received and stationData
            tmpPassengerTable.push({   // use "key" and "value" so data are ready to be used by D3js on client side
                "key":   passengerObject.CurrentStationID.toString(),
                "value": {
                    passengers: passengerObject,
                    station:    stationObject
                }
            });
            /*
             todo: only send the minimum required data
             {TotalAlighting: d.value.passengers.TotalAlighting,
             TotalBoarding: d.value.passengers.TotalBoarding,
             LineNumber: d.value.passengers.LineNumber,
             StartStationID: d.value.passengers.StartStationID,
             EndStationID: d.value.passengers.EndStationID,
             platformlat: d.value.station.platformlat,
             platformlng: d.value.station.platformlng};
             */
        } // push to tmpPassengerTable


        // Keep track of the last data received each physical train
        if (!tmpAPCObject.hasOwnProperty([passengerObject.OwnModuleNo])) {
            tmpAPCObject[passengerObject.OwnModuleNo] = passengerObject;
        } else if (tmpAPCObject [passengerObject.OwnModuleNo].DateAndTimeUnix < passengerObject.DateAndTimeUnix) {
            tmpAPCObject[passengerObject.OwnModuleNo] = passengerObject;
        }
    } // for - all passenger data/parsed all received records

    // passenger data succesfully parsed - store globally for new clients
    passengerTable = tmpPassengerTable;
    for (let prop in tmpAPCObject) {
        if (tmpAPCObject.hasOwnProperty(prop)) { // do not iterate over inherited props
            APCObject[prop] = tmpAPCObject[prop];
        }
    }

    // Send only new information to clients, keep the total APCObject globally available to send to new connecting clients
    io.to(room).emit("trains", tmpAPCObject);
    io.to(room).emit("pax", passengerTable);
    io.to(room).emit("LastPaxUpdateTime", lastPaxUpdateTimeUnix);
    //return { passengers: tmpPassengerTable, trains: tmpAPCObject, updateTime: lastPaxUpdateTime};
}; // parsePassengerData ()


let lastPaxUpdateTimeUnix = 0;
function setLastPaxUpdateTime (DateAndTimeUnix) {
    if (DateAndTimeUnix > lastPaxUpdateTimeUnix) {
        lastPaxUpdateTimeUnix = DateAndTimeUnix;
    }
} // setLastPaxUpdateTime()

APC.getLastPaxUpdateTimeUnix = function () {
    return lastPaxUpdateTimeUnix;
}; // getLastPaxUpdateTimeUnix()

module.exports = function (pio) {
    io = pio;
    return APC;
};