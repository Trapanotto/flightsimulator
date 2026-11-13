import { Group } from 'three/webgpu';
import type { LocalFrame } from '@geo';
import { type DeviceClass, type WorldLayer, emptyLayer } from '../layers';

/** The buildings of the world. Built in phase 2; until then an empty layer. */
export function createBuildingLayer(_frame: LocalFrame, _device: DeviceClass): WorldLayer {
  const group = new Group();
  group.name = 'Buildings';
  return emptyLayer(group);
}
