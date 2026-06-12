import React from 'react'
import ReactDOM from 'react-dom/client'
import 'normalize.css';
import App from './App';
// import { bitable as connector } from '@base-open/connector-api'

import { bitable } from "@lark-base-open/js-sdk";

window.bitable = bitable;
// let pre, cur
//   pre = cur = Date.now();
// setInterval(() => {
//   cur = Date.now();
//   console.log('visibility gap', cur - pre)
//   pre = cur;
// }, 100)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
