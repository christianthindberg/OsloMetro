/**
 * Created by christianthindberg on 13/09/16.
 */

var rKeys = {};
// redis key
function rk() {
    return Array.prototype.slice.call(arguments).join(":");
}
var bMaster = false;

function isMaster() {
    return bMaster;
}
function setMaster (bState) {
    bMaster = bState;
}

rKeys.base = "om"; // short for "OsloMetro"
rKeys.users = rk(rKeys.base,'users'); //list
rKeys.status = rk(rKeys.base,'status'); //String, :userName
rKeys.cts = rk(rKeys.base, "cts");  // hash of all valid cts events
rKeys.cts_timestamp = rk(rKeys.base, "cts", "timestamp"); // sorted list of cts-events
rKeys.cts_logical_nr = rk(rKeys.base, "cts","logical_nr"); // sorted lists, one for each logical train number, each list containing the cts events for said logical train number
rKeys.cts_logical_nr_keys = rk(rKeys.base, "cts","logical_nr","key"); // sorted lists, one for each logical train number, each list containing the cts events for said logical train number

rKeys.cts_trains_carset_nr = rk(rKeys.base,'cts',"carset_nr"); //not sure how to implement this yet:-)

rKeys.rk = rk;
rKeys.isMaster = isMaster;
rKeys.setMaster = setMaster;
module.exports = rKeys;


/* To use in main file

 var
 ...
 rKeys = require('./rKeys.module.node.js'),
 rk = rKeys.rk;
 ...
 client.get(rk(rKeys.status,userName), ...)
 */

/* Todo: add retries ...
 var client = redis.createClient({
 retry_strategy: function (options) {
 if (options.error.code === 'ECONNREFUSED') {
 // End reconnecting on a specific error and flush all commands with a individual error
 return new Error('The server refused the connection');
 }
 if (options.total_retry_time > 1000 * 60 * 60) {
 // End reconnecting after a specific timeout and flush all commands with a individual error
 return new Error('Retry time exhausted');
 }
 if (options.times_connected > 10) {
 // End reconnecting with built in error
 return undefined;
 }
 // reconnect after
 return Math.max(options.attempt * 100, 3000);
 }
 });
 */
