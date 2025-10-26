/**
 * LagMonitor - A utility to detect main thread lag in web applications
 *
 * This monitor works by measuring the time difference between when a frame was
 * scheduled to render and when it actually renders. If this difference exceeds
 * a threshold, it's considered as lag.
 */
class LagMonitor {
    constructor({
        lagThresholdMs = 50, // Threshold to consider a frame as lagging (in ms)
        reportingInterval = 1000, // How often to log statistics (in ms)
        sampleSize = 10, // Number of samples to keep for calculating average
        onLagDetected = null, // Callback when lag is detected
        onStatsUpdate = null, // Callback when stats are updated
        debugMode = false // Whether to log all frame timings
    } = {}) {
        this.lagThresholdMs = lagThresholdMs;
        this.reportingInterval = reportingInterval;
        this.sampleSize = sampleSize;
        this.onLagDetected = onLagDetected;
        this.onStatsUpdate = onStatsUpdate;
        this.debugMode = debugMode;

        this.frameTimes = [];
        this.lagCount = 0;
        this.frameCount = 0;
        this.lastReportTime = 0;
        this.running = false;
        this.lastFrameTimestamp = 0;

        // Bind methods
        this.checkFrame = this.checkFrame.bind(this);
    }

    /**
     * Start monitoring for main thread lag
     */
    start() {
        if (this.running) return;

        this.running = true;
        this.lagCount = 0;
        this.frameCount = 0;
        this.frameTimes = [];
        this.lastReportTime = performance.now();
        this.lastFrameTimestamp = performance.now();

        // Schedule the first frame check
        requestAnimationFrame(this.checkFrame);

        console.log('🔍 LagMonitor: Started monitoring main thread');
    }

    /**
     * Stop monitoring for main thread lag
     */
    stop() {
        this.running = false;
        console.log('🔍 LagMonitor: Stopped monitoring');
    }

    /**
     * Check the current frame for lag
     * @param {DOMHighResTimeStamp} timestamp
     */
    checkFrame(timestamp) {
        if (!this.running) return;

        // Calculate frame time
        const frameTime = timestamp - this.lastFrameTimestamp;
        this.lastFrameTimestamp = timestamp;

        // Add to the samples, keeping only the most recent ones
        this.frameTimes.push(frameTime);
        if (this.frameTimes.length > this.sampleSize) {
            this.frameTimes.shift();
        }

        // Check if this frame is lagging
        if (frameTime > this.lagThresholdMs) {
            this.lagCount++;

            if (this.debugMode) {
                console.warn(`🔍 LagMonitor: Lag detected - ${Math.round(frameTime)}ms (threshold: ${this.lagThresholdMs}ms)`);
            }

            // Call lag callback if provided
            if (typeof this.onLagDetected === 'function') {
                this.onLagDetected({
                    frameTime,
                    timestamp,
                    lagThreshold: this.lagThresholdMs
                });
            }
        }

        this.frameCount++;

        // Report statistics periodically
        const now = performance.now();
        if (now - this.lastReportTime >= this.reportingInterval) {
            this.reportStatistics();
            this.lastReportTime = now;
        }

        // Schedule next frame check
        requestAnimationFrame(this.checkFrame);
    }

    /**
     * Report current lag statistics
     */
    reportStatistics() {
        // Calculate average frame time
        const avgFrameTime = this.frameTimes.reduce((sum, time) => sum + time, 0) / this.frameTimes.length;
        const fps = Math.round(1000 / avgFrameTime);

        // Calculate lag percentage
        const lagPercentage = (this.lagCount / this.frameCount) * 100 || 0;

        // Call stats update callback if provided
        if (typeof this.onStatsUpdate === 'function') {
            this.onStatsUpdate({
                fps,
                avgFrameTime: Math.round(avgFrameTime),
                lagCount: this.lagCount,
                frameCount: this.frameCount,
                lagPercentage: Math.round(lagPercentage)
            });
        }

        // Reset counters
        this.lagCount = 0;
        this.frameCount = 0;
    }
}

// Export for use in module environments
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = { LagMonitor };
}
