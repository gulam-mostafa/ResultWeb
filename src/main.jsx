import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App, { AppErrorBoundary } from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { SchoolDataProvider } from './context/SchoolDataContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <SchoolDataProvider>
              <App />
            </SchoolDataProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);

