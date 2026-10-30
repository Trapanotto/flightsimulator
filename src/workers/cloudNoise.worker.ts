/// <reference lib="webworker" />
import { detailNoiseData, shapeNoiseData } from '../render/cloudNoise';

declare const self: DedicatedWorkerGlobalScope;

/** Builds the cloud noises off the main thread (render/VolumetricClouds.ts). */
self.onmessage = () => {
  const shape = shapeNoiseData(64);
  const detail = detailNoiseData(32);
  self.postMessage({ shape, detail }, [shape.buffer, detail.buffer]);
};
