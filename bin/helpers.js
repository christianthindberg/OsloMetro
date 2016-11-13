/**
 * Created by christianthindberg on 03/10/2016.
 *
 * A few small helper functions
 */

"use strict";

const assert = require ("assert");

function MyIsNaN(p) {
    //var test = typeof p;
    //if (typeof p === "number")
    //  console.log ("MyIsNaN- p: " + p + " typeof p: " + test);
    return typeof p !== "number" || Number.isNaN(p);
} // MyIsNaN

function MyIsNumber(p) {
    var test = typeof p;
    if (typeof p !== "number")
        console.log("MyIsNumber- p: " + p + " typeof p: " + test);
    return typeof p === "number" && !Number.isNaN(p);
} // MyisNumber
// end small helpers

function getToBerthName (msgObject) {
    if (!msgObject) {
        log.error("getToBerthName - msgObject null");
        return null;
    }
    if (!msgObject.values) {
        log.error("getToBerthName - msgObject.values null");
        return null;
    }
    if (!msgObject.values.to_infra_berth)
        return null;
    if (!msgObject.values.to_infra_berth.Name)
        return null;
    return msgObject.values.to_infra_berth.Name;
}
function checkToBerthLatLng (msgObject) {
    if (!msgObject) {
        log.error("parseFloatLatLng - msgObject null");
        return false;
    }
    if (!msgObject.values) {
        log.error("parseFloatLatLng - msgObject.values null");
        return false;
    }
    if (!msgObject.values.to_infra_berth)
        return false;
    if (!msgObject.values.to_infra_berth.StartLatitude || !msgObject.values.to_infra_berth.StartLongitude)
        return false;
    return true;
}

function incProperty (obj, prop) {
    assert (typeof obj === "object");
    assert (typeof prop === "string");
    if (obj === "null" || typeof obj !== "object" || !prop)
        return false;
    if (!obj.hasOwnProperty([prop]))
        obj[prop] = 1;
    else
        obj[prop] += 1;
    return true;
} // incProperty()

function removeSpaces  (obj) {
    assert (typeof obj === "object");
    //JSON.parse(JSON.stringify(obj)) -- fastest way to clone object in javascript, ref. stackoverflow
    return JSON.parse(JSON.stringify(obj).replace(/"\s+|\s+"/g, '"')); //"\s+|\s+" ?
} // removeSpaces()

function millisToHrMinSec (millis) {
    assert(typeof millis === "number");

    let ms = 1000 * Math.round(millis/1000); // round to nearest second
    let d = new Date(ms);
    return d.getHours()-1 + ":" + d.getMinutes() + ":" + d.getSeconds(); // "4:59:03"
} // millisToMinsAndSecs()

function HrMinSecToMillis (hr, min, sec) {
    return (hr*60*60 + min*60 + sec) * 1000;
} // HrMinSecToMillis()

function isEmpty(obj) {
    if (!obj)
        return true;
    for (let x in obj) { return false; }
    return true;
} // isEmpty()

exports.MyIsNaN = MyIsNaN;
exports.MyIsNumber = MyIsNumber;
exports.getToBerthName = getToBerthName;
exports.checkToBerthLatLang = checkToBerthLatLng;
exports.incProperty = incProperty;
exports.removeSpaces = removeSpaces;
exports.millisToHrMinSec = millisToHrMinSec;
exports.HrMinSecToMillis = HrMinSecToMillis;
exports.isEmpty = isEmpty;