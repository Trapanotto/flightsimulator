/// <reference types="vite/client" />

import type { App } from './app/App';

declare global {
  interface Window {
    tfs?: {
      app: App;
      version: string;
    };
  }
}

export {};
