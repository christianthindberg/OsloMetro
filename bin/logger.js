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

'use strict';

var log4js = require('log4js');
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
  var logDir = process.env.NODE_LOG_DIR !== undefined ? process.env.NODE_LOG_DIR : __dirname;
  var logDirSub;

  if (process.platform === "win32") {
    //logDirSub = logDir + "\\";
    logDirSub = "D:\\home\\LogFiles\\Application\\"
  } else {
    logDirSub = logDir + "/";
  }

  var config = {
    "appenders": [
      {
        "type": "file",
        "filename": logDirSub + "application.log",
        "pattern": "-yyyy-MM-dd",
        "layout": {
          "type": "pattern",
          "pattern": "%d (PID: %x{pid}) %p %c - %m",
          "tokens": {
            "pid" : function() { return process.pid; }
          }
        }
      }
    ]
  };

  log4js.configure(config, {});

  return {
    getLogger: function(category) {
      return log4js.getLogger(category);
    }
  };
}

module.exports = logger;
