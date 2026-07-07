/**
 * Frida 证书绕过 Agent
 * 注入到 QQ.exe 进程，Hook 证书验证函数，让其接受自签名证书
 */
function main() {
    console.log("[CertBypass] Starting... PID: " + Process.id);

    // Hook CertVerifyCertificateChainPolicy - 证书链验证
    try {
        var ptr = Module.findExportByName("crypt32.dll", "CertVerifyCertificateChainPolicy");
        if (ptr) {
            Interceptor.attach(ptr, {
                onLeave: function(retval) {
                    // 始终返回成功 (TRUE = 1)
                    retval.replace(1);
                }
            });
            console.log("[CertBypass] CertVerifyCertificateChainPolicy hooked");
        } else {
            console.log("[CertBypass] CertVerifyCertificateChainPolicy not found");
        }
    } catch(e) { console.warn("[CertBypass] Hook error: " + e.message); }

    // 备用: Hook CertGetCertificateChain - 获取证书链
    try {
        var ptr = Module.findExportByName("crypt32.dll", "CertGetCertificateChain");
        if (ptr) {
            Interceptor.attach(ptr, {
                onLeave: function(retval) {
                    // 确保返回成功
                    retval.replace(0); // ERROR_SUCCESS
                }
            });
            console.log("[CertBypass] CertGetCertificateChain hooked");
        }
    } catch(e) {}

    // 备用: Hook WinHTTP 证书验证
    try {
        var ptr = Module.findExportByName("winhttp.dll", "WinHttpCheckCertificate");
        if (ptr) {
            Interceptor.attach(ptr, {
                onLeave: function(retval) { retval.replace(1); }
            });
            console.log("[CertBypass] WinHttpCheckCertificate hooked");
        }
    } catch(e) {}

    // 报告完成
    try {
        var http = new XMLHttpRequest();
        http.open("POST", "http://127.0.0.1:3007/api/desktop-login/code-captured", false);
        http.setRequestHeader("Content-Type", "application/json");
        http.send(JSON.stringify({ action: "cert_bypass_injected", pid: Process.id || 0 }));
    } catch(e) {}
}
setTimeout(main, 500);
