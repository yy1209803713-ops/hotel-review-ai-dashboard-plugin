import '@lark-base-open/js-sdk/dist/style/dashboard.css';
import '@semi-bot/semi-theme-feishu-dashboard/semi.min.css';
import 'reset-css';
import './styles/tokens.css';
import './styles/app.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
