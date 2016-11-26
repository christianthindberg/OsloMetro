# OsloMetro
Live MetroMaps for the City of Oslo. Built on nodejs, socket.io, D3, Redis, Kinesis

Main Components

Producers - can be written in any language, and the data can be in any format. The Consumers (see below) do not make any assumptions regarding data format. The Web-server that is parsing the data, must of course
    implement a parser that knows the details of the data format in question.

    - CTS  C#, delivered from DRIV.
    Todo: split out as a separate service and place as close as possible to CTS-core to get data without delay and to eliminate risk of downtime due to instabilities in the DRIV solution
    - PAX   C#, runs as a windows service centrally at Sporveien
    Todo: redesign APC (automatic passenger counting solution) to send data to Kinesis in real time from each train

    - geometry-train (not implemented)
    - "selletronix-train"   Todo: read kinesis stream and visualize

    - weather data  (not implemented)
    - AiS (aktivitet i sporet/activities on the railroad tracks) (not implemented)
    - Beacon positioning: signals from beacons for train positioning outside area covered by CTS (i.e. at Ryen)

    The producers are standard Kinesis producers that send their data to a designated AWS Kinesis stream. See aws documentation on github for details.
    Producers should be kept as basic as possible, but with an emphasis of fault tolerance

Consumers   Nodejs/multilang daemon on AWS Elastic Beanstalk
    One Consumer for each Kinesis stream. These are basically clones of the standard AWS example on github with the following added functionality:
    - data read from kinesis stream is sent to Redis using redisclient.publish (topic, <data>).
    - The redis topic will be identical to the name of the kinesis stream defined in the "sample.properties" file, unless the environment variable REDIS_TOPIC is set, in which case the value if REDIS_TOPIC is used
    - If the environment variable RUTER_TOPIC is set, the consumer also publishes the data to Ruter Kafka with the value of RUTER_TOPIC as the topic.
        In order for the consumer to be able to publish to Ruter Kafka, the consumer must be assigned an Elastic IP adress so that the IP is fixed even if the consumer machine is terminated and a new instance created.
        Also, Ruter must open up access for the given IP address.

    The AWS multilang deamon makes it easy to just focus on writing the record processor. The downside is that using a script to start a JAVA program which in turn starts our record processor (one for each Kinesis Shard)
    makes it hard to debug the record processor directly in a debugger. Instead we are dependent on logging to file (should not use stdout as this is used by Multilang itself). As a consequence we keep the consumers as simple as possible.

    For development and testing, the consumers can also run locally on dev computer. This require that the dev computer has Redis installed locally and that it has AWS keys enabling read access to the Kinesis streams.

Redis
    Used for its publish/subscribe mechanism allowing the Kinesis Consumers an easy to use mechanism to forward its data to the web-server. One Kinesis stream mayt consist of several shards each having its RecordProcessor process.
    When they all publis to Redis we "get rid of parallelism" so the web server can consume events easily (using redisClient.on ("message",....) ).

    An alternative could have been for consumers to send messages directly to the web-server, and thereby beeing able to remove redis and reduce the number of components.
    This strategy would however have had some issues too, i.e. need for fixed IP-address, and not handling elastic beanstalk autoscaling.


    As the web-server has grown in functionality it has anyway a need for an operational data store, and redis is a good fit.

    Using Redis also opens up the possibility of having several different web-servers subscribing to the same topics while using the data for different purposes, and also opens up the possibility of splitting out work from the web-server
    and into various micro services. One such micro service could be to sum together alightings and boardings for each hour of an operating day and save to Redis, rather than having the web server do this work.

    Todo: rather than consumers publishing the event directly, a better implementation would be for consumers to add new events to a redis list and just publish information that a new event was added, enableing web-server(s) to consume events at their own pace

Web-server nodejs server running on AWS ElasticBeanstalk. Dependent on Redis as operational data store and to receive data from Consumers (see above). Dependent on socket.io to communicate with clients.
    Receives data in the form of redis.on ("message", <data>). Parses the data, stores events in Redis to enable replay of historical data, aggregations, queries etc. And broadcasts events to the clients.
    Require that Redis is installed locally for dev/test

    Has implemented parsers for CTS and PAX. Other parsers may be added as needed (Weather, geometry, workshop positioning, ...).

    Uses socket.io to exchange messages with clients

 Client Using D3 to visualize data and socket.io to coomunicate with the web-server
    /index: google map visulizing Oslo Metro Lines, display live train positions, passenger data and some passenger statistics
    /driver
    /cmd
    /log
    /data
    /london


Server Modules
    app
    www
    ctsparser
    ctslivestatus
    ctshistory
    apcrealtime
    infrastructure
    commands
    opstore
    helpers
    logger

Client Modules

    Draw infrastructure - tracks, stations, berths, track switches
    Map & Coordinate system - init map, screen-to-map, views - draw google map, no map, line map, individual lines...
    Draw trains live, train tails
    Draw trackstatus (i.e. accelerometer data)
    Draw AiS (from-to station, planned time, status now (work started, finished, ...)
    Draw Ghosts
    Draw Weather
    Draw information texts
    Draw passengers live
    Draw bar diagram
        Lines, Stations
    Draw CustomList
        OwnModules
        Trains delayed per line

Client/Server Communication

The following socket.io events are supported by the server:

In main module - WWW:

SESSION HANDLING
socketAuth (not implemented), i.e. solution do not requre clients to authenticate

"connection"
    send the following messages to the newly connected client
    "ip" and "id"
    "initinfrastructure"    containing the metro infrastructure
    "pax"                   passengerTable containing the most recently received passenger data
    "lastPaxUpdateTime"     message containing the time of the last registered alight/board event
    "trainsintraffic"       number of trains we have received CTS messages from recently (i.e. number of "active" trains)

    Todo: implement number of users connected, implement support for "one user, multiple tabs/command tab"

"disconnect"
    Update number of active users

ERROR
"client error"
    message generated by clients if they encounter an exception. Enables the server to log client exceptions

    Todo: implement client logger, so that log.info, log.debug, log.error etc are sent to the server (not only unhandled exceptions)

REQUESTS
A client may send requests for data. The following requests are supported:

    "operatingdayownmodulerequest"
        Sends an object containing the serial-number of of 3-car sets we have received passenger data from so far today (i.e. since 05.00 this morning) and their corresponding sum of alightings and sum of boardings

    "stationsrequest"
        Sends table of all stations to the client

    "berthsrequest"
        Sends table of all stations to the client

    "trackswitchesrequest"
        Sends table of all track switches to the client

    "tailrequest"
        sendd the "tail" of a train, i.e. list of latest berth-passings to the client

    "alltailsrequest"
        sends "tail" of all trains, i.e. array of lists of berth-passings

    "ghostrequest"
        sends list of all "ghost-trains" registered. A "ghost-train" is when the CTS generates a false signal, i.e. a signal not generated by a physical train

    Todo: implement requests for sending the hourly aggregages for passenger data per station, line, train that occured in so far this operating day, and as far back as we have data in Redis (i.e. last week...)

CTS AND PAX
    "cts_<event>", where event is one of: event, special, ghost, trnochg
    Events received from CTS, parsed and enriched (i.e. added info on whether it is a yellow train or not, added info on which line the train is servicing)
    The special, ghost, trnochg are generated by the server and not by the CTS. Special means the CTS sent us a CANCEL, EXIT, NOTD or other "special" event. Ghost indicates a false signal from CTS, trnochg is information that
     a change of logical train number occured.

     "trains"
     "pax"
     "LastPaxUpdateTime"

     "LineAggregateSlidingWindow"
     "StationAggregateSlidingWindow"
     "OwnModuleAggregateSlidingWindow"
     "LineAggregateFixedInterval1Hour"
     "StationAggregateFixedInterval1Hour"
     "OwnModuleAggregateFixedInterval1Hour"
     "LineAggregateFixedIntervalOperatingDay"
     "StationAggregateFixedIntervalOperatingDay"
     "OwnModuleAggregateFixedIntervalOperatingDay"


MISCELLANEOUS
"timetick"
    Broadcast time now in milliseconds since Epoch every second
    Enables the clients to display correct time (AWS servers use NTP-synched time)


"chat message"
    broadcast the message to all clients
    if message is a command, execute the command

    Todo: separate "command" as an independent topic from "chat message"


In module COMMANDS
    "chat message" - various messages are sent in response to commands received
    Todo: introduce new topic "cmd_reply" to separate from user chat

    "help" - list of available commands
    "blinkalarms" - toggle the joined map client to display more blinking alarms or not
    "destination" - toggle the joined map client to display train destination periodically, in addition to logical train number
    "socketlist" - sends list of connected sockets to the client
    "okberths" - sends list of all berths that we have received data from, used for verification/testing

In module CTSLIVESTATUS
    "removetrain" - If we do not receive any CTS-messages for a train in 1 hour we assume that it has exited the metro-system (f.ex. at Ryen) without
    generating an EXIT-event (it could however also be parked), and we broadcast a "removetrain" - message to the clients to inform them that they should not display the train anymore.

    Todo: Improve train handling to better differentiate between parked trains and trains that have excited by utilizing the fact that there are only a few places where trains can exit the signalling system

    "trainsintraffic" check - also sent from www


In module CTSHISTORY
    "history start"
    "history stop"
    "realtime"
    "aggregatehistory"


    Look at trains, trainsintraffic and OwnModuleAggregateFixedIntervalOperatingDay

