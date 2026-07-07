/**
 * MITM 代理服务 - 截获农场 WebSocket code
 */
var path = require("path");
var ProxyLib = null;
try { ProxyLib = require("http-mitm-proxy").Proxy; } catch(e) {}

var activeProxies = [];

function startProxy(options) {
    return new Promise(function(resolve, reject) {
        if (!ProxyLib) return reject(new Error("http-mitm-proxy 未安装"));
        var port = options.port || 18888;
        var onCode = options.onCode || function() {};
        var log = options.log || console.log;
        var proxy = new ProxyLib();

        proxy.onRequest(function(ctx, callback) {
            var method = ctx.clientToProxyRequest.method;
            var url = ctx.clientToProxyRequest.url || "";
            var host = (ctx.clientToProxyRequest.headers && ctx.clientToProxyRequest.headers.host) || "";
            if (url.includes("nqf.qq.com") && url.includes("code=")) {
                var m = url.match(/[?&]code=([a-zA-Z0-9_-]+)/);
                if (m && m[1]) {
                    log("[MITMProxy] CODE: " + m[1]);
                    onCode(m[1], url);
                }
            }
            return callback();
        });

        proxy.onError(function(ctx, err, kind) {
            log("[MITMProxy] " + kind + ": " + (err && err.message));
        });

        var caDir = path.join(process.cwd(), "data", "mitm-certs");
        proxy.listen({ port: port, sslCaDir: caDir }, function() {
            log("[MITMProxy] \u4EE3理已启动: 127.0.0.1:" + port);
            activeProxies.push(proxy);
            resolve({ port: port, caCertPath: path.join(caDir, "certs", "ca.pem"), proxy: proxy });
        });
    });
}

function stopAll() {
    activeProxies.forEach(function(p) { try { p.close(); } catch(e) {} });
    activeProxies = [];
}

module.exports = { startProxy: startProxy, stopAll: stopAll };
