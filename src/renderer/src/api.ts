import type { BoothAPI } from '../../preload/index'

declare global {
  interface Window {
    boothAPI: BoothAPI
  }
}

export const api: BoothAPI = window.boothAPI
