
// mlx-native.js - Apple Silicon adapter
// Bypasses Node HTTP overhead by talking via Unix Domain Sockets to mlx-serve runner.

const net = require('net');

async function mlxServeRequest(socketPath, body) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath }, () => {
      client.write(JSON.stringify(body) + '\n');
    });

    let data = '';
    client.on('data', chunk => {
      data += chunk.toString();
    });

    client.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });

    client.on('error', reject);
  });
}

module.exports = {
  mlxServeRequest
};
