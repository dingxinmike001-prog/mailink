/**

 * IMAP connection diagnostic tool

 * Used to collect and analyze detailed connection issue information

 */



const logger = require('../logger');



class ConnectionDiagnostic {

    constructor() {

        this.connectionHistory = new Map();

        this.errorPatterns = new Map();

        this.maxHistorySize = 100;

    }



    static getInstance() {

        if (!ConnectionDiagnostic.instance) {

            ConnectionDiagnostic.instance = new ConnectionDiagnostic();

        }

        return ConnectionDiagnostic.instance;

    }



    /**

     * Record connection events

     */

    logConnectionEvent(username, eventType, details) {

        const timestamp = Date.now();

        const event = {

            timestamp,

            type: eventType,

            details,

            datetime: new Date().toISOString()

        };



        if (!this.connectionHistory.has(username)) {

            this.connectionHistory.set(username, []);

        }



        const history = this.connectionHistory.get(username);

        history.push(event);



        // Limit history size

        if (history.length > this.maxHistorySize) {

            history.shift();

        }



        // Output diagnostic logs

        logger.info(`[ConnectionDiagnostic] ${eventType} [${username}]`, {

            ...details,

            timestamp,

            eventId: `${username}_${timestamp}`

        });

    }



    /**

     * Record connection errors

     */

    logConnectionError(username, error, context) {

        const errorInfo = {

            message: error.message,

            code: error.code,

            errno: error.errno,

            syscall: error.syscall,

            stack: error.stack?.substring(0, 1000),

            context

        };



        // Analyze error patterns

        const errorKey = `${error.code}_${error.message?.substring(0, 50)}`;

        if (!this.errorPatterns.has(errorKey)) {

            this.errorPatterns.set(errorKey, {

                count: 0,

                firstSeen: Date.now(),

                lastSeen: Date.now(),

                usernames: new Set()

            });

        }



        const pattern = this.errorPatterns.get(errorKey);

        pattern.count++;

        pattern.lastSeen = Date.now();

        pattern.usernames.add(username);



        // Classify errors

        const errorCategory = this.categorizeError(error);

        

        logger.error(`[ConnectionDiagnostic] connection error [${username}] [${errorCategory}]`, {

            ...errorInfo,

            category: errorCategory,

            patternCount: pattern.count,

            suggestion: this.getSuggestion(errorCategory, error)

        });



        return errorCategory;

    }



    /**

     * Error classification

     */

    categorizeError(error) {

        const message = error.message?.toLowerCase() || '';

        const code = error.code?.toLowerCase() || '';



        // SSL/TLS errors

        if (message.includes('bad_decrypt') || 

            message.includes('openssl') ||

            message.includes('ssl') ||

            message.includes('tls') ||

            message.includes('cipher') ||

            message.includes('certificate')) {

            return 'SSL_TLS_ERROR';

        }



        // Network errors

        if (code === 'econnreset' || 

            code === 'etimedout' ||

            code === 'econnrefused' ||

            code === 'enotfound' ||

            message.includes('socket hang up') ||

            message.includes('network')) {

            return 'NETWORK_ERROR';

        }



        // Authentication error

        if (message.includes('auth') ||

            message.includes('login') ||

            message.includes('password') ||

            message.includes('credential')) {

            return 'AUTH_ERROR';

        }



        // Timeout errors

        if (message.toLowerCase().includes('timeout') || code === 'etime') {

            return 'TIMEOUT_ERROR';

        }



        // Protocol errors

        if (message.includes('protocol') || message.includes('parse')) {

            return 'PROTOCOL_ERROR';

        }



        return 'UNKNOWN_ERROR';

    }



    /**

     * Get recommendations

     */

    getSuggestion(category, error) {

        const suggestions = {

            'SSL_TLS_ERROR': [

                'check network connection stability',

                'try switchingTLSversion',

                'check serverSSLcertificate',

                'consider using unencrypted connection for testing',

                'check for proxy or firewall interference'

            ],

            'NETWORK_ERROR': [

                'check network connection',

                'increase timeout',

                'checkDNSparse',

                'check firewall settings',

                'try a different network environment'

            ],

            'AUTH_ERROR': [

                'check username and password',

                'confirm whether authorization code is correct (QQmailbox)',

                'check whether account is locked',

                'confirmIMAPservice enabled'

            ],

            'TIMEOUT_ERROR': [

                'increase connection timeout',

                'check network latency',

                'reduce concurrent connections',

                'check server load'

            ],

            'PROTOCOL_ERROR': [

                'checkIMAPserver configuration',

                'updateIMAPclient library',

                'check server supported protocol version'

            ],

            'UNKNOWN_ERROR': [

                'view detailed error logs',

                'contact technical support',

                'try restarting the application'

            ]

        };



        return suggestions[category] || suggestions['UNKNOWN_ERROR'];

    }



    /**

     * Get connection statistics

     */

    getConnectionStats(username) {

        const history = this.connectionHistory.get(username) || [];

        

        const stats = {

            totalEvents: history.length,

            errorCount: 0,

            successCount: 0,

            lastError: null,

            lastSuccess: null,

            errorTypes: {},

            connectionDurations: [],

            recentErrors: []

        };



        history.forEach(event => {

            if (event.type === 'ERROR') {

                stats.errorCount++;

                stats.lastError = event;

                

                const errorType = event.details?.category || 'UNKNOWN';

                stats.errorTypes[errorType] = (stats.errorTypes[errorType] || 0) + 1;

                

                if (stats.recentErrors.length < 5) {

                    stats.recentErrors.push(event);

                }

            } else if (event.type === 'CONNECTED') {

                stats.successCount++;

                stats.lastSuccess = event;

            } else if (event.type === 'DISCONNECTED' && event.details?.duration) {

                stats.connectionDurations.push(event.details.duration);

            }

        });



        // Calculate average connection duration

        if (stats.connectionDurations.length > 0) {

            stats.avgConnectionDuration = stats.connectionDurations.reduce((a, b) => a + b, 0) / stats.connectionDurations.length;

        }



        return stats;

    }



    /**

     * Generate diagnostic report

     */

    generateDiagnosticReport(username) {

        const stats = this.getConnectionStats(username);

        const history = this.connectionHistory.get(username) || [];



        const report = {

            username,

            generatedAt: new Date().toISOString(),

            summary: {

                totalEvents: stats.totalEvents,

                successCount: stats.successCount,

                errorCount: stats.errorCount,

                successRate: stats.totalEvents > 0 ? ((stats.successCount / stats.totalEvents) * 100).toFixed(2) + '%' : 'N/A',

                avgConnectionDuration: stats.avgConnectionDuration ? `${Math.round(stats.avgConnectionDuration)}ms` : 'N/A'

            },

            errorAnalysis: {

                errorTypes: stats.errorTypes,

                recentErrors: stats.recentErrors.map(e => ({

                    time: e.datetime,

                    type: e.details?.category,

                    message: e.details?.message?.substring(0, 100)

                }))

            },

            recommendations: this.generateRecommendations(stats)

        };



        logger.info(`[ConnectionDiagnostic] diagnostic report [${username}]`, report);

        return report;

    }



    /**

     * Generate recommendations

     */

    generateRecommendations(stats) {

        const recommendations = [];



        if (stats.errorCount > stats.successCount) {

            recommendations.push('error rate too high, suggest checking network or server configuration');

        }



        if (stats.errorTypes['SSL_TLS_ERROR']) {

            recommendations.push('detectedSSL/TLSerror, suggest checking encryption configuration');

        }



        if (stats.errorTypes['NETWORK_ERROR']) {

            recommendations.push('detected network error, suggest checking network connection');

        }



        if (stats.errorTypes['TIMEOUT_ERROR']) {

            recommendations.push('detected timeout error, suggest increasing timeout or reducing concurrency');

        }



        if (stats.avgConnectionDuration && stats.avgConnectionDuration < 5000) {

            recommendations.push('connection duration short, possible connection instability issue');

        }



        return recommendations;

    }



    /**

     * Clear history records

     */

    clearHistory(username) {

        if (username) {

            this.connectionHistory.delete(username);

            logger.info(`[ConnectionDiagnostic] cleared [${username}]  history`);

        } else {

            this.connectionHistory.clear();

            this.errorPatterns.clear();

            logger.info('[ConnectionDiagnostic] cleared all history');

        }

    }

}



module.exports = ConnectionDiagnostic;