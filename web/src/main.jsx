import React from 'react';
import { createRoot } from 'react-dom/client';
import '@arco-design/web-react/dist/css/arco.css';
import App from './App.jsx';
import './styles.css';

document.body.setAttribute('arco-theme', 'dark');

createRoot(document.getElementById('root')).render(<App />);
