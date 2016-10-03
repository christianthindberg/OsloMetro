/**
 * Created by christianthindberg on 13/09/16.
 */

var keyStore = {};
// redis key
function keyMgr() {
    return Array.prototype.slice.call(arguments).join(":");
}
var bMaster = false;

function isMaster() {
    return bMaster;
}
function setMaster (bState) {
    bMaster = bState;
}

keyStore.base = "om"; // short for "OsloMetro"
keyStore.users = keyMgr(keyStore.base,'users'); //list
keyStore.status = keyMgr(keyStore.base,'status'); //String, :userName
keyStore.cts = keyMgr(keyStore.base, "cts");  // hash of all valid cts events
keyStore.cts_timestamp = keyMgr(keyStore.base, "cts", "timestamp"); // sorted list of cts-events
keyStore.cts_logical_nr = keyMgr(keyStore.base, "cts","logical_nr"); // sorted lists, one for each logical train number, each list containing the cts events for said logical train number
keyStore.cts_logical_nr_keys = keyMgr(keyStore.base, "cts","logical_nr","key"); // sorted lists, one for each logical train number, each list containing the cts events for said logical train number

keyStore.cts_trains_carset_nr = keyMgr(keyStore.base,'cts',"carset_nr"); //not sure how to implement this yet:-)

keyStore.keyMgr = keyMgr;
keyStore.isMaster = isMaster;
keyStore.setMaster = setMaster;
module.exports = keyStore;


/* To use in main file

 var
 ...
 opStore = require('./opStore.module.node.js'),
 keyMgr = opStore.keyMgr;
 ...
 client.get(keyMgr(opStore.status,userName), ...)
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
