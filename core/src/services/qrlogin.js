const axios = require('axios');
const QRCode = require('qrcode');

const ChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class MiniProgramLoginSession {
    static QUA = 'V1_HT5_QDT_0.70.2209190_x64_0_DEV_D';

    static Presets = {
        farm: {
            name: 'QQ经典农场 (Farm)',
            description: 'QQ经典农场小程序',
            appid: '1112386029'
        }
    };

    static getHeaders() {
        return {
            'qua': MiniProgramLoginSession.QUA,
            'host': 'q.qq.com',
            'accept': 'application/json',
            'content-type': 'application/json',
            'user-agent': ChromeUA
        };
    }

    static async requestLoginCode() {
        try {
            const response = await axios.get('https://q.qq.com/ide/devtoolAuth/GetLoginCode', {
                headers: this.getHeaders()
            });

            const { code, data } = response.data;

            if (+code !== 0) {
                throw new Error('获取登录码失败');
            }

            const loginCode = data.code || '';
            const loginUrl = `https://h5.qzone.qq.com/qqq/code/${loginCode}?_proxy=1&from=ide`;
            const image = await QRCode.toDataURL(loginUrl, {
                width: 300,
                margin: 1,
                errorCorrectionLevel: 'M',
            });

            return {
                code: loginCode,
                url: loginUrl,
                image,
            };
        } catch (error) {
            console.error('MP Request Login Code Error:', error.message);
            throw error;
        }
    }

    static async queryStatus(code) {
        try {
            const response = await axios.get(`https://q.qq.com/ide/devtoolAuth/syncScanSateGetTicket?code=${code}`, {
                headers: this.getHeaders()
            });

            if (response.status !== 200) {
                return { status: 'Error' };
            }

            const { code: resCode, data } = response.data;

            if (+resCode === 0) {
                if (+data.ok !== 1) return { status: 'Wait' };
                // 这里的 data.nick 字段可能存在，需要确认返回结构
                return { status: 'OK', ticket: data.ticket, uin: data.uin, nickname: data.nick || '' };
            }

            if (+resCode === -10003) return { status: 'Used' };

            return { status: 'Error', msg: `Code: ${resCode}` };
        } catch (error) {
            console.error('MP Query Status Error:', error.message);
            throw error;
        }
    }

    static async getAuthCode(ticket, appid = '1112386029') {
        try {
            const response = await axios.post('https://q.qq.com/ide/login', {
                appid,
                ticket
            }, {
                headers: this.getHeaders()
            });

            if (response.status !== 200) return '';

            const { code, data, message } = response.data;
            // code === 0 表示成功，auth code 在 data 字段中
            if (+code === 0 && data) {
                return data.authCode || data.code || data || '';
            }
            // code !== 0 表示错误（如 -3000），返回空字符串并输出日志
            console.error('[MiniProgramLoginSession] getAuthCode failed:', code, message || '');
            return '';
        } catch (error) {
            console.error('MP Get Auth Code Error:', error.message);
            return '';
        }
    }
}

module.exports = { MiniProgramLoginSession };
