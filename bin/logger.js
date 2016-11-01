/***
Copyright 2015 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Amazon Software License (the "License").
You may not use this file except in compliance with the License.
A copy of the License is located at

http://aws.amazon.com/asl/

or in the "license" file accompanying this file. This file is distributed
on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
express or implied. See the License for the specific language governing
permissions and limitations under the License.
***/

"use strict";

const log4js = require("log4js");
const os = require("os");
const process = require("process");
/*
var AWS = require('aws-sdk');
var awsConfig = require('./config');
var s3bucket = new AWS.S3({params: {Bucket: 'ctwebapplogdata'}});
s3bucket.createBucket(function() {
  var params = {Key: 'd3test', Body: 'Hello!'};

  s3bucket.upload(params, function(err, data) {
    if (err) {
      console.log("Error uploading data: ", err);
    } else {
      console.log("Successfully uploaded data to ctwebapplogdata/myKey");
    }
  });
});
*/


function logger() {
  const logDir = process.env.NODE_LOG_DIR !== undefined ? process.env.NODE_LOG_DIR : __dirname;
  const logDirSub = logDir + "/";

  /*
   {
   type: "console",
   category: "console"
   },
   */
  let config = {};

  config = {
    appenders: [
      {
        type:       "file",
        filename:   logDirSub + "oslometro.log", //logDirSub + "application.log",
        maxLogSize: 102400,
        backups:    3,
        pattern:    "-yyyy-MM-dd",
        layout:     {
          type:    "pattern",
          pattern: "%d (PID: %x{pid}) %p %c - %m",
          tokens:  {
            pid: function () {
              return process.pid;
            }
          } // tokens
        } // layout
      }, // appender
      {
        type: "console"
      }
    ]
  };

  log4js.configure(config, {});
  /*
  if (os.platform() === "darwin") { // running locally on Mac
    log4js.loadAppender("console");
    log4js.addAppender(log4js.appenders.console());
  }
  */

/*
 {
 type: "file",
 filename: logDirSub + "om-memuse.log",
 category: "memory-usage",
 layout: {
 type: "messagePassThrough"
 }
 } // appender2
 */

  return {
    getLogger: function(category) {
      return log4js.getLogger(category);
    }
  };
}

module.exports = logger;
