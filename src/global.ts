// CDN <script> entry: exposes the class as window.BolnaWebCall
import { BolnaWebCall } from "./call";

declare global {
  interface Window {
    BolnaWebCall: typeof BolnaWebCall;
  }
}

window.BolnaWebCall = BolnaWebCall;
