// https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audiosink.js

/**
 * Reads audio data from a RingBuffer populated by a worker thread.
 *
 * @class AudioReaderProcessor
 * @extends AudioWorkletProcessor
 **/
class AudioReaderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sharedArrayBuffer = options.processorOptions.sharedArrayBuffer;
    this.consumerSide = new RingBuffer(this.sharedArrayBuffer, Float32Array);
    this.mediaChannelCount = options.processorOptions.mediaChannelCount;
    // https://www.w3.org/TR/webaudio/#render-quantum-size
    const RENDER_QUANTUM_SIZE = 128;
    this.deinterleaveBuffer = new Float32Array(
      this.mediaChannelCount * RENDER_QUANTUM_SIZE,
    );
  }

  deinterleave(input, output) {
    let inputIdx = 0;
    let outputChannelCount = output.length;
    for (var i = 0; i < output[0].length; i++) {
      for (var j = 0; j < outputChannelCount; j++) {
        output[j][i] = input[inputIdx++];
      }
    }
  }

  process(inputs, outputs, params) {
    const read = this.consumerSide.pop(this.deinterleaveBuffer);
    if (read !== this.deinterleaveBuffer.length) {
      const filled = Math.max(0, read);
      this.deinterleaveBuffer.fill(0, filled);
      if (filled === 0) {
        for (const ch of outputs[0]) ch.fill(0);
        return true;
      }
    }
    this.deinterleave(this.deinterleaveBuffer, outputs[0]);
    return true;
  }
}

registerProcessor("audio-reader", AudioReaderProcessor);
