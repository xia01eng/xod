import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import contextMenu from 'electron-context-menu';
import { URL } from 'url';
import * as R from 'ramda';

import { URL_ACTION_PROTOCOL, URL_ACTION_PREFIX } from 'xod-client/dist/core/urlActions';

import * as EVENTS from '../shared/events';
import {
  listBoardsHandler,
  listPortsHandler,
  loadTargetBoardHandler,
  saveTargetBoardHandler,
  uploadToArduinoHandler,
  startDebugSessionHandler,
  stopDebugSessionHandler,
} from './arduinoActions';
import * as settings from './settings';
import { errorToPlainObject, IS_DEV, getFilePathToOpen } from './utils';
import * as WA from './workspaceActions';
import { configureAutoUpdater, subscribeOnAutoUpdaterEvents } from './autoupdate';

// =============================================================================
//
// Configure application
//
// =============================================================================

app.setName('xod');

configureAutoUpdater(autoUpdater, log);

if (process.env.USERDATA_DIR) {
  app.setPath('userData', process.env.USERDATA_DIR);
  settings.rewriteElectronSettingsFilePath(app.getPath('userData'));
}

if (IS_DEV) {
  // To prevent GL_ERROR in development version (black rectangles).
  app.disableHardwareAcceleration();
}

// =============================================================================
//
// Application main process
//
// =============================================================================

const getFileToOpen = getFilePathToOpen(app);

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win;
let confirmedWindowClose = false;

function createWindow() {
  // Create the browser window.
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'XOD IDE',
    show: false,
    // this is required for subpixel antialiasing to work
    backgroundColor: '#FFF',
    webPreferences: {
      partition: 'persist:main',
    },
  });
  win.maximize();
  // and load the index.html of the app.
  win.loadURL(`file://${__dirname}/../index.html`);

  // Open the DevTools.
  // win.webContents.openDevTools();

  contextMenu({ window: win });

  const { webContents } = win;

  const handleRedirect = (e, href) => {
    if (href !== webContents.getURL()) {
      e.preventDefault();
      const url = new URL(href);
      if (url.protocol === URL_ACTION_PROTOCOL && url.hostname === URL_ACTION_PREFIX) {
        win.webContents.send(
          EVENTS.XOD_URL_CLICKED,
          {
            actionName: url.pathname,
            params: R.fromPairs(Array.from(url.searchParams.entries())),
          }
        );
      } else {
        shell.openExternal(href);
      }
    }
  };
  webContents.on('will-navigate', handleRedirect);
  webContents.on('new-window', handleRedirect);

  win.on('close', (e) => {
    // a bit of magic, because of weird `onbeforeunload` behaviour.
    // see https://github.com/electron/electron/issues/7977
    if (!confirmedWindowClose) {
      e.preventDefault();
      win.webContents.send(EVENTS.REQUEST_CLOSE_WINDOW);
    }
  });

  // Emitted when the window is closed.
  win.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    win = null;
  });

  win.on('ready-to-show', win.show);
}

const subscribeToRemoteAction = (processName, remoteAction) => {
  ipcMain.on(processName, (event, data) => {
    event.sender.send(`${processName}:process`);
    remoteAction(event, data).then((result) => {
      event.sender.send(`${processName}:complete`, result);
    }).catch((err) => {
      event.sender.send(`${processName}:error`, errorToPlainObject(err));
    });
  });
};

configureAutoUpdater(autoUpdater, log);

const onReady = () => {
  if (IS_DEV) {
    require('devtron').install(); // eslint-disable-line global-require

    const {
      default: installExtension,
      REACT_DEVELOPER_TOOLS,
      REDUX_DEVTOOLS,
    } = require('electron-devtools-installer'); // eslint-disable-line global-require

    installExtension([REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS])
      .catch(err => console.log(err)); // eslint-disable-line no-console
  }
  settings.setDefaults();

  subscribeToRemoteAction(EVENTS.SAVE_ALL, WA.subscribeToSaveAll);

  let debugPort = null;
  let userAttemptedCloseSerialPort = false;

  const stopDebugSession = (event) => {
    if (debugPort) {
      userAttemptedCloseSerialPort = true;
      stopDebugSessionHandler(event, debugPort);
    }
  };

  WA.subscribeToWorkspaceEvents(ipcMain);
  ipcMain.on('UPLOAD_TO_ARDUINO', (event, payload) => Promise.resolve()
    .then(() => ((debugPort) ? stopDebugSession(event) : event))
    .then(() => uploadToArduinoHandler(event, payload))
  );
  ipcMain.on(EVENTS.START_DEBUG_SESSION, startDebugSessionHandler(
    (port) => {
      userAttemptedCloseSerialPort = false;
      debugPort = port;
    },
    (sendErr) => {
      if (!userAttemptedCloseSerialPort) { sendErr(); }
      debugPort = null;
    }
  ));
  ipcMain.on(EVENTS.STOP_DEBUG_SESSION, stopDebugSession);
  ipcMain.on(EVENTS.LIST_PORTS, listPortsHandler);
  ipcMain.on(EVENTS.LIST_BOARDS, listBoardsHandler);
  ipcMain.on(EVENTS.GET_SELECTED_BOARD, loadTargetBoardHandler);
  ipcMain.on(EVENTS.SET_SELECTED_BOARD, saveTargetBoardHandler);
  ipcMain.on(EVENTS.CONFIRM_CLOSE_WINDOW, () => {
    confirmedWindowClose = true;
    win.close();
  });
  ipcMain.on(EVENTS.INSTALL_LIBRARIES, WA.saveLibraries);

  createWindow();
  win.webContents.on('did-finish-load', () => {
    getFileToOpen()
      .then(WA.loadProjectByPath)
      .then(project => win.webContents.send(EVENTS.REQUEST_SHOW_PROJECT, project))
      .catch(err => win.webContents.send(EVENTS.ERROR, err));

    WA.prepareWorkspaceOnLaunch(
      (eventName, data) => win.webContents.send(eventName, data)
    );

    subscribeOnAutoUpdaterEvents(
      (eventName, data) => win.webContents.send(eventName, data),
      ipcMain,
      autoUpdater
    );

    autoUpdater.checkForUpdates();
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', onReady);

// Quit when all windows are closed.
app.on('window-all-closed', app.quit);

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (win === null) {
    createWindow();
  }
});
