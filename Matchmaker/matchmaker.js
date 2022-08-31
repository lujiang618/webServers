// Copyright Epic Games, Inc. All Rights Reserved.
var enableRedirectionLinks = true;
var enableRESTAPI = true;

const defaultConfig = {
	// The port clients connect to the matchmaking service over HTTP
	HttpPort: 2080,
	UseHTTPS: false,
	// The matchmaking port the signaling service connects to the matchmaker
	MatchmakerPort: 2081,

	// Log to file
	LogToFile: true,
    inited: false,

    StandbyNum: 1,
    InitSSNum: 1,
    Address: "192.168.99.145",
    ControllerInterval: 1000*60,
    StreamerRunPath: "../../../../UDxyLauncher.sh",
    CirrusRunPath: "./start.sh"
};

var childProcessMap = new Map()

// Similar to the Signaling Server (SS) code, load in a config.json file for the MM parameters
const argv = require('yargs').argv;

var configFile = (typeof argv.configFile != 'undefined') ? argv.configFile.toString() : '.\\config.json';
console.log(`configFile ${configFile}`);
const config = require('./modules/config.js').init(configFile, defaultConfig);
console.log("Config: " + JSON.stringify(config, null, '\t'));

const express = require('express');
var cors = require('cors');
const app = express();
const http = require('http').Server(app);
const fs = require('fs');
const path = require('path');
const logging = require('./modules/logging.js');
const { exec } = require('child_process');
logging.RegisterConsoleLogger();

if (config.LogToFile) {
	logging.RegisterFileLogger('./logs');
}

// A list of all the Cirrus server which are connected to the Matchmaker.
var cirrusServers = new Map();

//
// Parse command line.
//

if (typeof argv.HttpPort != 'undefined') {
	config.HttpPort = argv.HttpPort;
}
if (typeof argv.MatchmakerPort != 'undefined') {
	config.MatchmakerPort = argv.MatchmakerPort;
}
if (typeof argv.StandbyNum != 'undefined') {
	config.StandbyNum = argv.StandbyNum;
}
if (typeof argv.InitSSNum != 'undefined') {
	config.InitSSNum = argv.InitSSNum;
}
if (typeof argv.Address != 'undefined') {
	config.Address = argv.Address;
}
if (typeof argv.ControllerInterval != 'undefined') {
	config.ControllerInterval = argv.ControllerInterval;
}
if (typeof argv.StreamerRunPath != 'undefined') {
	config.StreamerRunPath = argv.StreamerRunPath;
}
if (typeof argv.CirrusRunPath != 'undefined') {
	config.CirrusRunPath = argv.CirrusRunPath;
}

http.listen(config.HttpPort, () => {
    console.log('HTTP listening on *:' + config.HttpPort);
});


if (config.UseHTTPS) {
	//HTTPS certificate details
	const options = {
		key: fs.readFileSync(path.join(__dirname, './certificates/client-key.pem')),
		cert: fs.readFileSync(path.join(__dirname, './certificates/client-cert.pem'))
	};

	var https = require('https').Server(options, app);

	//Setup http -> https redirect
	console.log('Redirecting http->https');
	app.use(function (req, res, next) {
		if (!req.secure) {
			if (req.get('Host')) {
				var hostAddressParts = req.get('Host').split(':');
				var hostAddress = hostAddressParts[0];
				if (httpsPort != 443) {
					hostAddress = `${hostAddress}:${httpsPort}`;
				}
				return res.redirect(['https://', hostAddress, req.originalUrl].join(''));
			} else {
				console.error(`unable to get host name from header. Requestor ${req.ip}, url path: '${req.originalUrl}', available headers ${JSON.stringify(req.headers)}`);
				return res.status(400).send('Bad Request');
			}
		}
		next();
	});

	https.listen(443, function () {
		console.log('Https listening on 443');
	});
}

// No servers are available so send some simple JavaScript to the client to make
// it retry after a short period of time.
function sendRetryResponse(res) {
	res.send(`All ${cirrusServers.size} Cirrus servers are in use. Retrying in <span id="countdown">2</span> seconds.
	<script>
		var countdown = document.getElementById("countdown").textContent;
		setInterval(function() {
			countdown--;
			if (countdown == 0) {
				window.location.reload(1);
			} else {
				document.getElementById("countdown").textContent = countdown;
			}
		}, 1000);
	</script>`);
}

// Get a Cirrus server if there is one available which has no clients connected.
function getAvailableCirrusServer() {
	for (cirrusServer of cirrusServers.values()) {
		if (cirrusServer.numConnectedClients === 0 && cirrusServer.ready === true) {

			// Check if we had at least 45 seconds since the last redirect, avoiding the
			// chance of redirecting 2+ users to the same SS before they click Play.
			if( cirrusServer.lastRedirect ) {
				if( ((Date.now() - cirrusServer.lastRedirect) / 1000) < 45 )
					continue;
			}
			cirrusServer.lastRedirect = Date.now();

			return cirrusServer;
		}
	}

	console.log('WARNING: No empty Cirrus servers are available');
	return undefined;
}

function getAvailableCirrusServerCount() {
    let availableCount = 0

    for (cirrusServer of cirrusServers.values()) {
		if (cirrusServer.numConnectedClients === 0 && cirrusServer.ready === true) {

			// Check if we had at least 45 seconds since the last redirect, avoiding the
			// chance of redirecting 2+ users to the same SS before they click Play.
			if( cirrusServer.lastRedirect ) {
				if( ((Date.now() - cirrusServer.lastRedirect) / 1000) < 45 )
					continue;
			}
			cirrusServer.lastRedirect = Date.now();

			availableCount++
		}
	}

    return availableCount
}

function getReadyCirrusServerCount() {
    let readyCount = 0

    for (cirrusServer of cirrusServers.values()) {
		if (cirrusServer.ready === true) {
			readyCount++
		}
	}

    return readyCount
}

if(enableRESTAPI) {
	// Handle REST signalling server only request.
	app.options('/signallingserver', cors())
	app.get('/signallingserver', cors(),  (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.json({ signallingServer: `${cirrusServer.address}:${cirrusServer.port}`});
			console.log(`Returning ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			res.json({ signallingServer: '', error: 'No signalling servers available'});
		}
	});
}

if(enableRedirectionLinks) {
	// Handle standard URL.
	app.get('/', (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.redirect(`http://${cirrusServer.address}:${cirrusServer.port}/`);
			//console.log(req);
			console.log(`Redirect to ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			sendRetryResponse(res);
		}
	});

	// Handle URL with custom HTML.
	app.get('/custom_html/:htmlFilename', (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.redirect(`http://${cirrusServer.address}:${cirrusServer.port}/custom_html/${req.params.htmlFilename}`);
			console.log(`Redirect to ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			sendRetryResponse(res);
		}
	});
}

//
// Connection to Cirrus.
//

const net = require('net');

function disconnect(connection) {
	console.log(`Ending connection to remote address ${connection.remoteAddress}`);
	connection.end();
}

let maxPort = 7001
function controller() {
    console.log("controller start.......................")

    const availableCount = getAvailableCirrusServerCount()

    console.log("serverCount", cirrusServers.size)
    console.log("availableCount",availableCount)

    add(getAddNum(availableCount))
    reduce(getReduceNum(availableCount))

    if (!config.inited) config.inited = true
}

function getAddNum(availableCount) {
    const serverCount = cirrusServers.size
    if (serverCount>30) return 0

    if (!config.inited)  return config.InitSSNum

    const childProcessCount = childProcessMap.size
    const readyCount = getReadyCirrusServerCount()

    if (childProcessCount-readyCount >= config.StandbyNum) return 0  // 启动中streamer数量 >= 备用数量时 不在启动新的streamer

    if (availableCount >= config.StandbyNum) return 0

    return config.StandbyNum - availableCount
}

function getReduceNum(availableCount) {
    const serverCount = cirrusServers.size
    if (serverCount < config.InitSSNum) return 0

    const readyCount = getReadyCirrusServerCount()
    if (readyCount <= config.InitSSNum) return 0

    if (availableCount <= config.StandbyNum) return 0

    return availableCount - config.StandbyNum
}

// 只关streamer不关闭signalling
// TODO: 不应该频繁的kill 进程
function reduce(num) {
    console.log("reduce number ",num)
    if (num == 0) return

    let reduceNum = 0
    for (cirrusServer of cirrusServers.values()) {
        if (reduceNum >= num) return
		if (cirrusServer.numConnectedClients !== 0 || !cirrusServer.ready) continue

        console.log("reduce cirrusServer",cirrusServer)
        const cirrusProcess = childProcessMap.get(cirrusServer.port)
        if (cirrusProcess) {
            cirrusServer.ready = false
            cirrusProcess.kill()
            reduceNum++
        }
	}
}

function add(num) {
    console.log("add number ",num)
    if (num == 0) return

    let addNum = 0
    for (cirrusServer of cirrusServers.values()) {
		if (addNum === num) return
		if (cirrusServer.ready === true) continue
        if (childProcessMap.has(cirrusServer.port)) continue

        console.log("add cirrusServer",cirrusServer)
        runStreamer(cirrusServer.port, parseInt(cirrusServer.port)+1)
        addNum++
	}

	if (addNum === num) return

    // 单机不能无限制的启动，最多 99/3 = 33 个服务器
    if ( maxPort > 7099) return

    for (let i=addNum; i<num; i++) {
        const currentHttpPort =  maxPort++
        const currentStreamerPort =  maxPort++
        const currentSFUPort =  maxPort++

        runCirrus(currentHttpPort, currentStreamerPort, currentSFUPort)
        runStreamer(currentHttpPort, currentStreamerPort)
    }
}

function runCirrus(httpPort, streamerPort, SFUPort) {
    let cmdArr = [
        config.CirrusRunPath,
        "--UseMatchmaker --matchmakerAddress",
        config.Address,
        "--matchmakerPort",
        config.MatchmakerPort,
        "--PublicIp",
        config.Address,
        "--HttpPort",
        httpPort,
        "--StreamerPort",
        streamerPort,
        "--SFUPort",
        SFUPort,
    ]

    console.log('cmd:',cmdArr.join(" "))
    execCommand(cmdArr.join(" "))
}

function runStreamer(httpPort,streamPort) {
    cmdArr = [
        config.StreamerRunPath,
        "-PixelStreamingURL=ws://127.0.0.1:"+streamPort,
        "-RenderOffScreen -WINDOWED -ResX=1920 -ResY=1080 -log",
    ]

    console.log('cmd:',cmdArr.join(" "))
    streamerProcess = execCommand(cmdArr.join(" "))

    if (!streamerProcess) return

    streamerProcess.on('exit',(code)=>{
        if (childProcessMap.delete(httpPort)) {
            console.log('delete error ok')
        }
        console.log('streamer process exit, code ', code,"httpPort ", httpPort)
    })

    childProcessMap.set(httpPort, streamerProcess)
}

function execCommand(cmd) {
    return exec(cmd, {} , function(err, stdout, stderr){
        if (err) {
            console.error(err);
        } else if (stderr.length > 0) {
            console.error(stderr.toString());
        } else {
            console.log("stdout:",stdout);
        }
    })
}

const matchmaker = net.createServer((connection) => {
	connection.on('data', (data) => {
		try {
			message = JSON.parse(data);

			if(message) console.log(`Message TYPE: ${message.type}`);
		} catch(e) {
			console.log(`ERROR (${e.toString()}): Failed to parse Cirrus information from data: ${data.toString()}`);
			disconnect(connection);
			return;
		}
		if (message.type === 'connect') {
			// A Cirrus server connects to this Matchmaker server.
			cirrusServer = {
				address: message.address,
				port: message.port,
				numConnectedClients: 0,
				lastPingReceived: Date.now()
			};
			cirrusServer.ready = message.ready === true;

			// Handles disconnects between MM and SS to not add dupes with numConnectedClients = 0 and redirect users to same SS
			// Check if player is connected and doing a reconnect. message.playerConnected is a new variable sent from the SS to
			// help track whether or not a player is already connected when a 'connect' message is sent (i.e., reconnect).
			if(message.playerConnected == true) {
				cirrusServer.numConnectedClients = 1;
			}

			// Find if we already have a ciruss server address connected to (possibly a reconnect happening)
			let server = [...cirrusServers.entries()].find(([key, val]) => val.address === cirrusServer.address && val.port === cirrusServer.port);

			// if a duplicate server with the same address isn't found -- add it to the map as an available server to send users to.
			if (!server || server.size <= 0) {
				console.log(`Adding connection for ${cirrusServer.address.split(".")[0]} with playerConnected: ${message.playerConnected}`)
				cirrusServers.set(connection, cirrusServer);
            } else {
				console.log(`RECONNECT: cirrus server address ${cirrusServer.address.split(".")[0]} already found--replacing. playerConnected: ${message.playerConnected}`)
				var foundServer = cirrusServers.get(server[0]);

				// Make sure to retain the numConnectedClients from the last one before the reconnect to MM
				if (foundServer) {
					cirrusServers.set(connection, cirrusServer);
					console.log(`Replacing server with original with numConn: ${cirrusServer.numConnectedClients}`);
					cirrusServers.delete(server[0]);
				} else {
					cirrusServers.set(connection, cirrusServer);
					console.log("Connection not found in Map() -- adding a new one");
				}
			}
		} else if (message.type === 'streamerConnected') {
			// The stream connects to a Cirrus server and so is ready to be used
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.ready = true;
				console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} ready for use`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'streamerDisconnected') {
			// The stream connects to a Cirrus server and so is ready to be used
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.ready = false;
				console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} no longer ready for use`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'clientConnected') {
			// A client connects to a Cirrus server.
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.numConnectedClients++;
				console.log(`Client connected to Cirrus server ${cirrusServer.address}:${cirrusServer.port}`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'clientDisconnected') {
			// A client disconnects from a Cirrus server.
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.numConnectedClients--;
				console.log(`Client disconnected from Cirrus server ${cirrusServer.address}:${cirrusServer.port}`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'ping') {
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.lastPingReceived = Date.now();
			} else {
				disconnect(connection);
			}
		} else {
			console.log('ERROR: Unknown data: ' + JSON.stringify(message));
			disconnect(connection);
		}
	});

	// A Cirrus server disconnects from this Matchmaker server.
	connection.on('error', () => {
		cirrusServer = cirrusServers.get(connection);
		if(cirrusServer) {
			cirrusServers.delete(connection);
			console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} disconnected from Matchmaker`);
		} else {
			console.log(`Disconnected machine that wasn't a registered cirrus server, remote address: ${connection.remoteAddress}`);
		}
	});
});

matchmaker.listen(config.MatchmakerPort, () => {
    // controller()
    setInterval(function(){
        controller()
    }, config.ControllerInterval)

	console.log('Matchmaker listening on *:' + config.MatchmakerPort);
});
