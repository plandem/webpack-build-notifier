/**
 * @class WebpackBuildNotifierPlugin
 * @extends Object
 * A Webpack plugin that generates OS notifications for build steps using node-notifier.
 */
import path from 'path';
import process from 'process';
import os from 'os';
import notifier from 'node-notifier';
import stripAnsi from 'strip-ansi';
import FormData from 'form-data';
import fs from 'fs';
import { exec, execFileSync } from 'child_process';
import { Notification } from 'node-notifier/notifiers/notificationcenter';
import { CompilationResult, Config, CompilationStatus } from './types';
import webpack from 'webpack';

const DEFAULT_ICON_PATH = path.resolve(__dirname, 'icons');

export default class WebpackBuildNotifierPlugin {
  private appName: string | undefined = undefined;
  private buildSuccessful: boolean = false;
  private hasRun: boolean = false;

  // config options
  private title: string = 'Webpack Build';
  private logo?: string;
  private sound: string = 'Submarine';
  private successSound: string;
  private warningSound: string;
  private failureSound: string;
  private compilationSound: string;
  private suppressSuccess: boolean | 'always' | 'initial' = false;
  private suppressWarning: boolean = false;
  private suppressCompileStart: boolean = true;
  private activateTerminalOnError: boolean = false;
  private showDuration: boolean = false;
  private remote?: string;
  private successIcon: string = path.join(DEFAULT_ICON_PATH, 'success.png');
  private warningIcon: string = path.join(DEFAULT_ICON_PATH, 'warning.png');
  private failureIcon: string = path.join(DEFAULT_ICON_PATH, 'failure.png');
  private compileIcon: string = path.join(DEFAULT_ICON_PATH, 'compile.png');
  private onCompileStart?: (compilation: webpack.compiler.Compiler) => void;
  private onComplete?: (compilation: webpack.compilation.Compilation, status: CompilationStatus) => void;
  private onClick: (notifier: notifier.NodeNotifier, options: Notification) => void = () => this.activateTerminalWindow;
  private onTimeout?: (notifier: notifier.NodeNotifier, options: Notification) => void;
  private messageFormatter?: (error: CompilationResult, filepath: string) => string;
  private notifyOptions?: Notification;

  constructor(cfg?: Config) {
    Object.assign(this, cfg);

    if (this.sound) {
      this.successSound = this.successSound ?? this.sound;
      this.warningSound = this.warningSound ?? this.sound;
      this.failureSound = this.failureSound ?? this.sound;
      this.compilationSound = this.compilationSound ?? this.sound;
    }

    this.registerSnoreToast();

    notifier.on('click', this.onClick);
    /* istanbul ignore else */
    if (this.onTimeout) {
      notifier.on('timeout', this.onTimeout);
    }
  }

  public apply(compiler: webpack.Compiler): void {
    if (compiler.hooks && compiler.hooks.watchRun && compiler.hooks.done) {
      // for webpack >= 4
      /* istanbul ignore else */
      if (!this.suppressCompileStart) {
        compiler.hooks.watchRun.tapAsync('webpack-build-notifier', this.onCompilationWatchRun);
      }
      compiler.hooks.done.tap('webpack-build-notifier', this.onCompilationDone);
    } else {
      // for webpack < 4
      /* istanbul ignore else */
      if (!this.suppressCompileStart) {
        compiler.plugin('watch-run', this.onCompilationWatchRun);
      }
      compiler.plugin('done', this.onCompilationDone);
    }
  }

  private readonly activateTerminalWindow = (): void => {
    if (process.platform === 'darwin') {
      // TODO: is there a way to translate $TERM_PROGRAM into the application name
      // to make this more flexible?
      exec('TERM="$TERM_PROGRAM"; ' +
        '[[ "$TERM" == "Apple_Terminal" ]] && TERM="Terminal"; ' +
        '[[ "$TERM" == "vscode" ]] && TERM="Visual Studio Code"; ' +
        'osascript -e "tell application \\"$TERM\\" to activate"');
    } else if (process.platform === 'win32') {
      // TODO: Windows platform
    }
  };

  private readonly formatMessage = (
    error: CompilationResult,
    filepath: string
  ): string => {
    let message: string | undefined = undefined;
    if (this.messageFormatter) {
      message = this.messageFormatter(error, filepath);
    } else {
      message = (error.message || error.details);
      if (message && error.module && error.module.resource) {
        message = `${filepath}${os.EOL}${message!.replace(error.module.resource, '')}`;
      }
    }

    if (message === undefined) {
      return 'Unknown';
    } else if (typeof message === 'string') {
      return message.substr(0, 256); // limit message length to 256 characters, fixes #20
    } else {
      throw `Invalid message type '${typeof message}'; messageFormatter must return a string.`;
    }
  };

  private readonly onCompilationDone = (results: webpack.Stats): void => {
    let notify: boolean = false;
    let title = `${this.title} - `;
    let msg = 'Build successful!';
    let icon = this.successIcon;
    let sound = this.successSound;
    let compilationStatus = CompilationStatus.SUCCESS;

    if (results.hasErrors()) {
      const error = this.getFirstWarningOrError(results.compilation, 'errors');
      const errorFilePath = error.module && error.module.resource ? error.module.resource : '';
      notify = true;
      compilationStatus = CompilationStatus.ERROR;
      title += 'Error';
      msg = this.formatMessage(error, errorFilePath);
      icon = this.failureIcon;
      sound = this.failureSound;
      this.buildSuccessful = false;
    } else if (!this.suppressWarning && results.hasWarnings()) {
      const warning = this.getFirstWarningOrError(results.compilation, 'warnings');
      const warningFilePath = warning.module && warning.module.resource ? warning.module.resource : '';
      notify = true;
      compilationStatus = CompilationStatus.WARNING;
      title += 'Warning';
      msg = this.formatMessage(warning, warningFilePath);
      icon = this.warningIcon;
      sound = this.warningSound;
      this.buildSuccessful = false;
    } else {
      title += 'Success';
      if (this.showDuration) {
        msg += ` [${results.endTime! - results.startTime!} ms]`;
      }
      /* istanbul ignore else */
      if (this.suppressSuccess === 'always' || (this.suppressSuccess === 'initial' && !this.hasRun)) {
        notify = false;
      } else if (this.suppressSuccess === false || !this.buildSuccessful) {
        notify = true; // previous build failed, let's show a notification even if success notifications are suppressed
      }
      this.buildSuccessful = true;
    }

    /* istanbul ignore else */
    if (notify) {
      this.notify(Object.assign(this.notifyOptions || {}, {
        title,
        sound,
        icon,
        appName: this.appName,
        message: stripAnsi(msg),
        contentImage: this.logo,
        wait: !this.buildSuccessful
      }));

      /* istanbul ignore else */
      if (this.onComplete) {
        this.onComplete(results.compilation, compilationStatus);
      }
    }

    /* istanbul ignore else */
    if (this.activateTerminalOnError && !this.buildSuccessful) {
      this.activateTerminalWindow();
    }

    this.hasRun = true;
  };

  private readonly onCompilationWatchRun = (
    compiler: webpack.compiler.Compiler,
    callback: Function
  ): void => {

    this.notify({
      appName: this.appName,
      title: this.title,
      message: 'Compilation started...',
      contentImage: this.logo,
      icon: this.compileIcon,
      sound: this.compilationSound
    } as Notification);

    /* istanbul ignore else */
    if (this.onCompileStart) {
      this.onCompileStart(compiler);
    }
    callback();
  };

  private readonly notify = (notification: Notification): void => {
    if (!this.remote) {
      notifier.notify(notification);
      return;
    }

    const form = new FormData();
    form.append('title', notification.title);
    form.append('message', notification.message);
    form.append('sound', notification.sound);

    if (notification.icon) {
      form.append('icon', fs.createReadStream(notification.icon));
    }

    if (notification.contentImage) {
      form.append('contentImage', fs.createReadStream(notification.contentImage));
    }

    form.submit(this.remote);
  }

  private readonly registerSnoreToast = (): void => {
    // ensure the SnoreToast appId is registered, which is needed for Windows Toast notifications
    // this is necessary in Windows 8 and above, (Windows 10 post build 1709), where all notifications must be generated
    // by a valid application.
    // see: https://github.com/KDE/snoretoast, https://github.com/RoccoC/webpack-build-notifier/issues/20
    /* istanbul ignore else */
    if (process.platform === 'win32') {
      const versionParts = os.release().split('.');
      const winVer = +(`${versionParts[0]}.${versionParts[1]}`);
      /* istanbul ignore else */
      if (winVer >= 6.2) {
        // Windows version >= 8
        const snoreToast = path.join(
          require.resolve('node-notifier'),
          '../vendor/snoreToast',
          `snoretoast-${process.arch === 'x64' ? 'x64' : 'x86'}.exe`
        );
        try {
          execFileSync(
            snoreToast,
            [
              '-appID',
              'Snore.DesktopToasts',
              '-install',
              'SnoreToast.lnk',
              snoreToast,
              'Snore.DesktopToasts'
            ]
          );
          this.appName = 'Snore.DesktopToasts';
        } catch (e) {
          console.error('An error occurred while attempting to install the SnoreToast AppID!', e);
        }
      }
    }
  };

  private readonly getFirstWarningOrError = (
    compilation: webpack.compilation.Compilation,
    type: 'warnings' | 'errors'
  ): any => {
    /* istanbul ignore else */
    if (compilation.children && compilation.children.length) {
      for (let i = 0; i < compilation.children.length; i++) {
        const warningsOrErrors = compilation.children[i][type];
        /* istanbul ignore else */
        if (warningsOrErrors && warningsOrErrors[0]) {
          return warningsOrErrors[0];
        }
      }
    }
    return compilation[type][0];
  }
}

module.exports = WebpackBuildNotifierPlugin;
