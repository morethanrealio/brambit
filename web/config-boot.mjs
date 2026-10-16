// Imported first by server.mjs: reads the config file (BRAMBIT_CONFIG_FILE)
// into process.env before any other module reads a setting, and watches it.
import { startConfigFile } from './config-file.mjs';

startConfigFile({ file: process.env.BRAMBIT_CONFIG_FILE, pinned: process.env.BRAMBIT_CONFIG_PINNED });
