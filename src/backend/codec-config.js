// The single source of truth for the WebCodecs VP9 configs. src/backend/probe.js decides whether
// native WebCodecs can be trusted here, and src/backend/webcodecs.js is what then runs — so a
// config the probe validated must be the config production uses, or the verdict means nothing.

export const CODEC = 'vp09.00.10.08';

/**
 * @param {{lossless:boolean, W:number, H:number, fps?:number, bitrate?:number}} o
 * @returns {VideoEncoderConfig}
 */
export function encoderConfig({ lossless, W, H, fps=30, bitrate }){
  const cfg = { codec:CODEC, width:W, height:H, framerate:fps, latencyMode:'quality' };
  if(lossless) cfg.bitrateMode='quantizer';
  else cfg.bitrate=bitrate||2_000_000;
  return cfg;
}

/** @returns {VideoDecoderConfig} */
export function decoderConfig({ W, H }){
  return { codec:CODEC, codedWidth:W, codedHeight:H };
}
