// Copyright Epic Games, Inc. All Rights Reserved.
var enableRedirectionLinks = false;
var enableRESTAPI = true;

const defaultConfig = {
	// The port clients connect to the matchmaking service over HTTP
	HttpPort: 90,
	UseHTTPS: false,
	// The matchmaking port the signaling service connects to the matchmaker
	MatchmakerPort: 9999,

	// Log to file
	LogToFile: true,

    ControllerInterval: 60,
    MinAvailableServer: 2,
    StartPort: 7000,
    EndPort: 7018,

    Address: "",

    StreamerRunPath: "",
    CirrusRunPath: "",

    UeUdpSenderPortStart: 19032,
    UeUdpRecievePortStart: 6060,
    UeConfigIniPath: "",

    ResX: 1920,
    ResY: 1080,
};

var childProcessMap = new Map()
var udpPorts = new Map();
var startStreamerMap = new Map();

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
const defaultAddress = '127.0.0.1'
const kill = require('tree-kill');

var lastTime = Date.now();
const reduceInterval = 120; // 用户操作后，多少秒后删除streamer
const stopStreamerInterval = 600; // 每间隔指定时间，检查是否要停止ue服务。
const startStreamerInterval = 10; // 每隔指定时间，从队列读取信息，启动ue

// const redis = require('./db/redis')
// const redisDevOptions = require('./config/redis.dev')
// const redisTestOptions = require('./config/redis.test')
// const redisDemoOptions = require('./config/redis.demo')

// const redisDev = redis.createClient(redisDevOptions.host,redisDevOptions.port,redisDevOptions.password,redisDevOptions.db)
// const redisTest = redis.createClient(redisTestOptions.host,redisTestOptions.port,redisTestOptions.password,redisTestOptions.db)
// const redisDemo = redis.createClient(redisDemoOptions.host,redisDemoOptions.port,redisDemoOptions.password,redisDemoOptions.db)
// const redisUdpPortKey = 'cpic:ue:udp:port'

// function resetRedis() {
//     redisDev.del(redisUdpPortKey)
//     redisTest.del(redisUdpPortKey)
//     redisDemo.del(redisUdpPortKey)
// }

// function updateRedis(httpPort, udpPort) {
//     redisDev.hSet(redisUdpPortKey,httpPort, JSON.stringify(udpPort))
//     redisTest.hSet(redisUdpPortKey,httpPort, JSON.stringify(udpPort))
//     redisDemo.hSet(redisUdpPortKey,httpPort, JSON.stringify(udpPort))
// }


// 启动时，清空ue udp prot
// resetRedis()

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
if (typeof argv.MinAvailableServer != 'undefined') {
	config.MinAvailableServer = argv.MinAvailableServer > 1 ? argv.MinAvailableServer : 1; // 最少要启动1个server
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
if (typeof argv.UeConfigIniPath != 'undefined') {
	config.UeConfigIniPath = argv.UeConfigIniPath;
}
if (typeof argv.UeUdpSenderPortStart != 'undefined') {
	config.UeUdpSenderPortStart = argv.UeUdpSenderPortStart;
}
if (typeof argv.UeUdpRecievePortStart != 'undefined') {
	config.UeUdpRecievePortStart = argv.UeUdpRecievePortStart;
}
if (typeof argv.ResX != 'undefined') {
	config.ResX = argv.ResX;
}
if (typeof argv.ResY != 'undefined') {
	config.ResY = argv.ResY;
}
if (typeof argv.StartPort != 'undefined') {
	config.StartPort = argv.StartPort;
}
if (typeof argv.EndPort != 'undefined') {
	config.EndPort = argv.EndPort;
}

if (!config.StreamerRunPath || !config.CirrusRunPath || !config.Address || !config.UeConfigIniPath) {
    console.error("缺少必要的启动参数");
    throw new Error("缺少必要的启动参数")
}

const maxStreamerNumber = (config.EndPort-config.StartPort) / 3 + 1;

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
	res.send(`All ${cirrusServers.size} Cirrus servers are in use. Retrying in <span id="countdown">3</span> seconds.
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

			// Check if we had at least 10 seconds since the last redirect, avoiding the
			// chance of redirecting 2+ users to the same SS before they click Play.
			// In other words, give the user 10 seconds to click play button the claim the server.
			if( cirrusServer.hasOwnProperty('lastRedirect')) {
				if( ((Date.now() - cirrusServer.lastRedirect) / 1000) < 10 )
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

app.use('/images', express.static(path.join(__dirname, './images')))

if(enableRESTAPI) {
	// Handle REST signalling server only request.
	app.options('/signallingserver', cors())
	app.get('/signallingserver', cors(),  (req, res) => {
        lastTime = Date.now();
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.json({ signallingServer: `${cirrusServer.address}:${cirrusServer.port}`});
			console.log(`Returning ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			res.json({ signallingServer: '', error: 'No signalling servers available'});
		}

        addServer(getAddNum(getAvailableCirrusServerCount()));
	});
}

if(enableRedirectionLinks) {
	// Handle standard URL.
	app.get('/', (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
            redirectUrl = `https://${config.Address}:${config.HttpPort}/signal/${cirrusServer.port}/`
			res.redirect(redirectUrl);
			console.log(`Redirect to ${redirectUrl}`);
		} else {
            addServer(getAddNum(getAvailableCirrusServerCount()))
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

function controller() {
    const readyCount = getReadyCirrusServerCount()
    const availableCount = getAvailableCirrusServerCount()

    console.log("server count:", cirrusServers.size)
    console.log("ready count:", readyCount)
    console.log("streamer count:", childProcessMap.size)
    console.log("available count:", availableCount)
    console.log("starting count:", startStreamerMap.size)

    addServer(getAddNum(availableCount))
}

function getAddNum(availableCount) {

    if (childProcessMap.size >= maxStreamerNumber) return 0; // 启动的ue达到上线，不在启动

    if (availableCount + startStreamerMap.size >= config.MinAvailableServer) return 0; // 空闲+启动中的streamer 大于设置的备用数量时，不在启动

    return config.MinAvailableServer - availableCount - startStreamerMap.size;
}

function addServer(num) {
    console.log("add number ",num)
    if (num == 0) return

    let addNum = 0
    for (cirrusServer of cirrusServers.values()) {
		if (addNum === num) return
		if (cirrusServer.ready === true) continue  // 已经有streamer
        if (startStreamerMap.get(cirrusServer.port)) continue // 还在等待执行的
        if (childProcessMap.get(cirrusServer.port)) continue  // 是否在启动中
        const udpPort = udpPorts.get(cirrusServer.port);

        const params = {
            'httpPort':cirrusServer.port,
            'streamPort':parseInt(cirrusServer.port)+1,
            'udpPort': udpPort,
            'startTime': Date.now()
        }

        startStreamerMap.set(cirrusServer.port, params)
        addNum++
	}
}

function runStreamer(httpPort, streamPort, udpPort) {
    if (childProcessMap.size > getReadyCirrusServerCount()) return
    if (childProcessMap.get(httpPort)) return

    childProcessMap.set(httpPort, null)

    changeUeConfigIni(udpPort)  // 每次启动时，先修改udp port

    cmdArr = [
        config.StreamerRunPath,
        "-PixelStreamingURL=ws://"+defaultAddress+":"+streamPort,
        "-AudioMixer -RenderOffScreen -WINDOWED",
        "-ResX="+config.ResX+" -ResY="+config.ResY+" -log",
    ]

    streamerProcess = execCommand(cmdArr.join(" "))

    if (streamerProcess) {
        streamerProcess.on('close',(code)=>{
            childProcessMap.delete(httpPort)
            console.log('streamer process closed, code: ', code," httpPort: ", httpPort)
        })
    }

    killStreamer(childProcessMap.get(httpPort)) // 新启动之前，kill之前的进程
    childProcessMap.set(httpPort, streamerProcess)
}

function execCommand(cmd) {
    console.log('cmd:', cmd)
    return exec(cmd, {} , (err, stdout, stderr) => {})
}

function changeUeConfigIni(udpPort) {
    const file = config.UeConfigIniPath
    const data = `udpSendPort=${udpPort.send}
udpRecievePort=${udpPort.receiver}`

    const fd = fs.openSync (file, 'w+')
    fs.writeSync(fd, data, 0, 'utf-8')
    fs.closeSync(fd)
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
				console.log(`RECONNECT: cirrus server address ${cirrusServer.address} already found--replacing. playerConnected: ${message.playerConnected}`)
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
            lastTime = Date.now();
			// A client disconnects from a Cirrus server.
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
                cirrusServer.numConnectedClients = cirrusServer.numConnectedClients === 0 ? 0 : --cirrusServer.numConnectedClients;
				console.log(`Client disconnected from Cirrus server ${cirrusServer.address}:${cirrusServer.port}`);
				if(cirrusServer.numConnectedClients === 0) {
					// this make this server immediately available for a new client
					cirrusServer.lastRedirect = 0;
				}
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


function initSignaler() {
    for (let i = 0; i < maxStreamerNumber; i++) {
        // 单机不能无限制的启动，最多 99/3 = 33 个服务器
        if ( config.StartPort > config.EndPort) return

        const currentHttpPort =  config.StartPort++
        const currentStreamerPort =  config.StartPort++
        const currentSFUPort =  config.StartPort++

        const udpPort = {
            'send': config.UeUdpSenderPortStart++,
            'receiver': config.UeUdpRecievePortStart++
        }
        udpPorts.set(currentHttpPort, udpPort);

        setTimeout(() => {
            runCirrus(currentHttpPort, currentStreamerPort, currentSFUPort)
        }, (i + 1) * 5 * 1000);
    }
}

function runCirrus(httpPort, streamerPort, SFUPort) {
    let cmdArr = [
        config.CirrusRunPath,
        "--UseMatchmaker --matchmakerAddress",
        defaultAddress,
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

    execCommand(cmdArr.join(" "))
}

function init() {
    initSignaler()
    addServer(config.MinAvailableServer)
}

init()

function startStreamer() {
    const params = getStartParams()

    if (!params) return

    runStreamer(params.httpPort,params.streamPort,params.udpPort);
}

function getStartParams() {
    for (params of startStreamerMap.values()) {
        startStreamerMap.delete(params.httpPort);
        if (childProcessMap.get(params.httpPort)) {
            continue
        }

        return params
    }

    return null
}

function getReduceNum() {
    const availableCount = getAvailableCirrusServerCount()

    if (startStreamerMap.size > 0) return 0; // 有启动中streamer，不应该在去缩减

    if ( ( Date.now() - lastTime) / 1000 < reduceInterval ) return 0; // 如果有用户打开模型，则2分钟内不删除

    if (availableCount <= config.MinAvailableServer) return 0;

    return availableCount - config.MinAvailableServer;
}

// 只关streamer不关闭signalling
function reduceServer() {
    num = getReduceNum()
    console.log("reduce number ",num)
    if (num == 0) return

    if (startStreamerMap.size > 0) return 0; // 有启动中streamer，不应该在去缩减

    for (cirrusServer of cirrusServers.values()) {
		if (cirrusServer.numConnectedClients > 0 || !cirrusServer.ready) continue

        console.log("reduce cirrusServer",  cirrusServer)
        cirrusServer.ready = false
        killStreamer(childProcessMap.get(cirrusServer.port))

        return
	}
}

function killStreamer(cirrusProcess) {
    if (!cirrusProcess) return

    kill(cirrusProcess.pid, 'SIGKILL', function(err) {
        if (err) {
            console.error('do kill failed:', err)
        }
    });

}

matchmaker.listen(config.MatchmakerPort, () => {
    setInterval(function(){
        controller()
    }, config.ControllerInterval * 1000);

    setInterval(()=>{
        startStreamer()
    }, startStreamerInterval * 1000);

    setInterval(()=>{
        reduceServer()
    }, stopStreamerInterval * 1000);

	console.log('Matchmaker listening on *:' + config.MatchmakerPort);
});
