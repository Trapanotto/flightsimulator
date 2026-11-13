/// <reference lib="webworker" />
import { cloudNoiseData } from './cloudNoise';

// Builds the cloud noises off the main thread (about half a second of work).
self.onmessage = () => {
  const data = cloudNoiseData();
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(data, [
    data.shape.buffer,
    data.detail.buffer,
    data.weather.buffer,
  ]);
};
