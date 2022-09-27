const redis = require('redis')


function createClient(host, port, password,db) {
    // 创建连接终端
    const options = {
        url: `redis://${host}:${port}/${db}`,
        password: password
    }
    const redisClient = redis.createClient(options)

    redisClient.on('error', err => console.error('------ Redis connection failed ------' + err))
	redisClient.on('connect', () => console.log('------ Redis connection succeed ------'))

    redisClient.connect();

    return redisClient
}

module.exports = {
    createClient
}