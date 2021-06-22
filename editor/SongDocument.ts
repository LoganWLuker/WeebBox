// Copyright (C) 2020 John Nesky, distributed under the MIT license.

import { Pattern, Song, Synth } from "../synth/synth";
import { SongRecovery, generateUid } from "./SongRecovery";
import { ColorConfig } from "./ColorConfig";
import { Layout } from "./Layout";
import { Selection } from "./Selection";
import { Change } from "./Change";
import { ChangeNotifier } from "./ChangeNotifier";
import { ChangeSong, setDefaultInstruments } from "./changes";
import { Config } from "../synth/SynthConfig";

//namespace beepbox {
interface HistoryState {
	canUndo: boolean;
	sequenceNumber: number;
	bar: number;
	channel: number;
	recoveryUid: string;
	prompt: string | null;
	selection: { x0: number, x1: number, y0: number, y1: number, start: number, end: number };
}

export class SongDocument {
	public song: Song;
	public synth: Synth;
	public notifier: ChangeNotifier = new ChangeNotifier();
	public selection: Selection = new Selection(this);
	public channel: number = 0;
	public muteEditorChannel: number = 0;
	public bar: number = 0;
	public recalcChannelNames: boolean;
	public autoPlay: boolean;
	public autoFollow: boolean;
	public enableNotePreview: boolean;
	public showFifth: boolean;
	public showLetters: boolean;
	public showChannels: boolean;
	public showScrollBar: boolean;
	public alwaysFineNoteVol: boolean = false;
	public alwaysShowSettings: boolean = true;
	public fullScreen: string;
	public enableChannelMuting: boolean;
	public colorTheme: string;
	public customTheme: string;
	public customTheme2: string;
	public displayBrowserUrl: boolean;
	public displayVolumeBar: boolean = true;
	public volume: number = 75;
	public trackVisibleBars: number = 16;
	public barScrollPos: number = 0;
	public prompt: string | null = null;
	public windowOctaves: number = 3 + (+(window.localStorage.getItem("extraOctaves") || "0"));
	public scrollableOctaves: number = Config.pitchOctaves - this.windowOctaves;
	public windowPitchCount: number = this.windowOctaves * Config.pitchesPerOctave + 1;
	private static readonly _maximumUndoHistory: number = 100;
	private _recovery: SongRecovery = new SongRecovery();
	private _recoveryUid: string;
	private _recentChange: Change | null = null;
	private _sequenceNumber: number = 0;
	private _stateShouldBePushed: boolean = false;
	private _recordedNewSong: boolean = false;
	public _waitingToUpdateState: boolean = false;

	constructor() {
		this.notifier.watch(this._normalizeSelection);

		this.autoPlay = window.localStorage.getItem("autoPlay") == "true";
		this.autoFollow = window.localStorage.getItem("autoFollow") == "true";
		this.enableNotePreview = window.localStorage.getItem("enableNotePreview") == "true";
		this.showFifth = window.localStorage.getItem("showFifth") == "true";
		this.showLetters = window.localStorage.getItem("showLetters") == "true";
		this.showChannels = window.localStorage.getItem("showChannels") == "true";
		this.showScrollBar = window.localStorage.getItem("showScrollBar") == "true";
		this.alwaysFineNoteVol = window.localStorage.getItem("alwaysFineNoteVol") == "true";
		this.enableChannelMuting = window.localStorage.getItem("enableChannelMuting") == "true";
		this.displayBrowserUrl = window.localStorage.getItem("displayBrowserUrl") != "false";
		this.displayVolumeBar = window.localStorage.getItem("displayVolumeBar") != "false";
		this.fullScreen = window.localStorage.getItem("fullScreen") || "normal";
		this.colorTheme = window.localStorage.getItem("colorTheme") || "jummbox classic";
		this.customTheme = window.localStorage.getItem("customTheme") || "https://www.teahub.io/photos/full/244-2448998_anime-girl-wallpaper-4k.jpg";
		this.customTheme2 = window.localStorage.getItem("customTheme2") || "https://media.istockphoto.com/videos/petals-sakura-cherry-blossom-falling-on-black-background-looped-video-id925176466?s=640x640";

		ColorConfig.setTheme(this.colorTheme);
		Layout.setFullScreen(this.fullScreen);

		if (window.localStorage.getItem("volume") != null) {
			this.volume = Math.min(<any>window.localStorage.getItem("volume") >>> 0, 75);
		}

		if (window.sessionStorage.getItem("currentUndoIndex") == null) {
			window.sessionStorage.setItem("currentUndoIndex", "0");
			window.sessionStorage.setItem("oldestUndoIndex", "0");
			window.sessionStorage.setItem("newestUndoIndex", "0");
		}

		let songString: string = window.location.hash;
		if (songString == "") {
			songString = this._getHash();
		}
		this.song = new Song(songString);
		if (songString == "" || songString == undefined) setDefaultInstruments(this.song);
		songString = this.song.toBase64String();
		this.synth = new Synth(this.song);
		this.synth.volume = this._calcVolume();

		let state: HistoryState | null = this._getHistoryState();
		if (state == null) {
			// When the page is first loaded, indicate that undo is NOT possible.
			state = { canUndo: false, sequenceNumber: 0, bar: 0, channel: 0, recoveryUid: generateUid(), prompt: null, selection: this.selection.toJSON() };
		}
		if (state.recoveryUid == undefined) state.recoveryUid = generateUid();
		this._replaceState(state, songString);
		window.addEventListener("hashchange", this._whenHistoryStateChanged);
		window.addEventListener("popstate", this._whenHistoryStateChanged);

		this.bar = state.bar;
		this.channel = state.channel;
		this._recoveryUid = state.recoveryUid;
		this.barScrollPos = Math.max(0, this.bar - (this.trackVisibleBars - 6));
		this.prompt = state.prompt;
		this.selection.fromJSON(state.selection);

		// For all input events, catch them when they are about to finish bubbling,
		// presumably after all handlers are done updating the model, then update the
		// view before the screen renders. mouseenter and mouseleave do not bubble,
		// but they are immediately followed by mousemove which does. 
		for (const eventName of ["input", "change", "click", "keyup", "keydown", "mousedown", "mousemove", "mouseup", "touchstart", "touchmove", "touchend", "touchcancel"]) {
			window.addEventListener(eventName, this._cleanDocument);
		}
	}

	public toggleDisplayBrowserUrl() {
		const state: HistoryState = this._getHistoryState()!;
		this.displayBrowserUrl = !this.displayBrowserUrl;
		this._replaceState(state, this.song.toBase64String());
	}

	private _getHistoryState(): HistoryState | null {
		if (this.displayBrowserUrl) {
			return window.history.state;
		} else {
			const json: any = JSON.parse(window.sessionStorage.getItem(window.sessionStorage.getItem("currentUndoIndex")!)!);
			return json == null ? null : json.state;
		}
	}

	private _getHash(): string {
		if (this.displayBrowserUrl) {
			return window.location.hash;
		} else {
			const json: any = JSON.parse(window.sessionStorage.getItem(window.sessionStorage.getItem("currentUndoIndex")!)!);
			return json == null ? "" : json.hash;
		}
	}

	private _replaceState(state: HistoryState, hash: string): void {
		if (this.displayBrowserUrl) {
			window.history.replaceState(state, "", "#" + hash);
		} else {
			window.sessionStorage.setItem(window.sessionStorage.getItem("currentUndoIndex") || "0", JSON.stringify({ state, hash }));
			window.history.replaceState(null, "", location.pathname);
		}
	}

	private _pushState(state: HistoryState, hash: string): void {
		if (this.displayBrowserUrl) {
			window.history.pushState(state, "", "#" + hash);
		} else {
			let currentIndex: number = Number(window.sessionStorage.getItem("currentUndoIndex"));
			let oldestIndex: number = Number(window.sessionStorage.getItem("oldestUndoIndex"));
			currentIndex = (currentIndex + 1) % SongDocument._maximumUndoHistory;
			window.sessionStorage.setItem("currentUndoIndex", String(currentIndex));
			window.sessionStorage.setItem("newestUndoIndex", String(currentIndex));
			if (currentIndex == oldestIndex) {
				oldestIndex = (oldestIndex + 1) % SongDocument._maximumUndoHistory;
				window.sessionStorage.setItem("oldestUndoIndex", String(oldestIndex));
			}
			window.sessionStorage.setItem(String(currentIndex), JSON.stringify({ state, hash }));
			window.history.replaceState(null, "", location.pathname);
		}
	}

	private _forward(): void {
		if (this.displayBrowserUrl) {
			window.history.forward();
		} else {
			let currentIndex: number = Number(window.sessionStorage.getItem("currentUndoIndex"));
			let newestIndex: number = Number(window.sessionStorage.getItem("newestUndoIndex"));
			if (currentIndex != newestIndex) {
				currentIndex = (currentIndex + 1) % SongDocument._maximumUndoHistory;
				window.sessionStorage.setItem("currentUndoIndex", String(currentIndex));
				setTimeout(this._whenHistoryStateChanged);
			}
		}
	}

	private _back(): void {
		if (this.displayBrowserUrl) {
			window.history.back();
		} else {
			let currentIndex: number = Number(window.sessionStorage.getItem("currentUndoIndex"));
			let oldestIndex: number = Number(window.sessionStorage.getItem("oldestUndoIndex"));
			if (currentIndex != oldestIndex) {
				currentIndex = (currentIndex + SongDocument._maximumUndoHistory - 1) % SongDocument._maximumUndoHistory;
				window.sessionStorage.setItem("currentUndoIndex", String(currentIndex));
				setTimeout(this._whenHistoryStateChanged);
			}
		}
	}

	private _whenHistoryStateChanged = (): void => {
		if (window.history.state == null && window.location.hash != "") {
			// The user changed the hash directly.
			this._sequenceNumber++;
			this._resetSongRecoveryUid();
			const state: HistoryState = { canUndo: true, sequenceNumber: this._sequenceNumber, bar: this.bar, channel: this.channel, recoveryUid: this._recoveryUid, prompt: null, selection: this.selection.toJSON() };
			new ChangeSong(this, window.location.hash);
			this.prompt = state.prompt;
			if (this.displayBrowserUrl) {
				this._replaceState(state, this.song.toBase64String());
			} else {
				this._pushState(state, this.song.toBase64String());
			}
			this.forgetLastChange();
			this.notifier.notifyWatchers();
			return;
		}

		const state: HistoryState | null = this._getHistoryState();
		if (state == null) throw new Error("History state is null.");

		// Abort if we've already handled the current state. 
		if (state.sequenceNumber == this._sequenceNumber) return;

		this.bar = state.bar;
		this.channel = state.channel;
		this._sequenceNumber = state.sequenceNumber;
		this.prompt = state.prompt;
		new ChangeSong(this, this._getHash());

		this._recoveryUid = state.recoveryUid;
		this.selection.fromJSON(state.selection);

		//this.barScrollPos = Math.min(this.bar, Math.max(this.bar - (this.trackVisibleBars - 1), this.barScrollPos));

		this.forgetLastChange();
		this.notifier.notifyWatchers();
	}

	private _cleanDocument = (): void => {
		this.notifier.notifyWatchers();
	}

	private _normalizeSelection = (): void => {
		// I'm allowing the doc.bar to drift outside the box selection while playing
		// because it may auto-follow the playhead outside the selection but it would
		// be annoying to lose your selection just because the song is playing.
		if ((!this.synth.playing && (this.bar < this.selection.boxSelectionBar || this.selection.boxSelectionBar + this.selection.boxSelectionWidth <= this.bar)) ||
			this.channel < this.selection.boxSelectionChannel ||
			this.selection.boxSelectionChannel + this.selection.boxSelectionHeight <= this.channel ||
			this.song.barCount < this.selection.boxSelectionBar + this.selection.boxSelectionWidth ||
			this.song.getChannelCount() < this.selection.boxSelectionChannel + this.selection.boxSelectionHeight ||
			(this.selection.boxSelectionWidth == 1 && this.selection.boxSelectionHeight == 1)) {
			this.selection.resetBoxSelection();
		}
	}

	private _updateHistoryState = (): void => {
		this._waitingToUpdateState = false;
		const hash: string = this.song.toBase64String();
		if (this._stateShouldBePushed) this._sequenceNumber++;
		if (this._recordedNewSong) {
			this._resetSongRecoveryUid();
		} else {
			this._recovery.saveVersion(this._recoveryUid, this.song.title, hash);
		}
		let state: HistoryState = { canUndo: true, sequenceNumber: this._sequenceNumber, bar: this.bar, channel: this.channel, recoveryUid: this._recoveryUid, prompt: this.prompt, selection: this.selection.toJSON() };
		if (this._stateShouldBePushed) {
			this._pushState(state, hash);
		} else {
			this._replaceState(state, hash);
		}
		this._stateShouldBePushed = false;
		this._recordedNewSong = false;
	}

	public record(change: Change, replace: boolean = false, newSong: boolean = false): void {
		if (change.isNoop()) {
			this._recentChange = null;
			if (replace) this._back();
		} else {
			change.commit();
			this._recentChange = change;
			this._stateShouldBePushed = this._stateShouldBePushed || !replace;
			this._recordedNewSong = this._recordedNewSong || newSong;
			if (!this._waitingToUpdateState) {
				// Defer updating the url/history until all sequenced changes have
				// committed and the interface has rendered the latest changes to
				// improve perceived responsiveness.
				window.requestAnimationFrame(this._updateHistoryState);
				this._waitingToUpdateState = true;
			}
		}
	}

	private _resetSongRecoveryUid(): void {
		this._recoveryUid = generateUid();
	}

	public openPrompt(prompt: string): void {
		this.prompt = prompt;
		const hash: string = this.song.toBase64String();
		this._sequenceNumber++;
		const state = { canUndo: true, sequenceNumber: this._sequenceNumber, bar: this.bar, channel: this.channel, recoveryUid: this._recoveryUid, prompt: this.prompt, selection: this.selection.toJSON() };
		this._pushState(state, hash);
	}

	public undo(): void {
		const state: HistoryState = this._getHistoryState()!;
		if (state.canUndo) this._back();
	}

	public redo(): void {
		this._forward();
	}

	public setProspectiveChange(change: Change | null): void {
		this._recentChange = change;
	}

	public forgetLastChange(): void {
		this._recentChange = null;
	}

	public lastChangeWas(change: Change | null): boolean {
		return change != null && change == this._recentChange;
	}

	public goBackToStart(): void {
		this.channel = 0;
		this.bar = 0;
		this.barScrollPos = 0;
		this.notifier.changed();
		this.synth.snapToStart();
		this.notifier.changed();
	}

	public savePreferences(): void {
		window.localStorage.setItem("autoPlay", this.autoPlay ? "true" : "false");
		window.localStorage.setItem("autoFollow", this.autoFollow ? "true" : "false");
		window.localStorage.setItem("enableNotePreview", this.enableNotePreview ? "true" : "false");
		window.localStorage.setItem("showFifth", this.showFifth ? "true" : "false");
		window.localStorage.setItem("showLetters", this.showLetters ? "true" : "false");
		window.localStorage.setItem("showChannels", this.showChannels ? "true" : "false");
		window.localStorage.setItem("showScrollBar", this.showScrollBar ? "true" : "false");
		window.localStorage.setItem("alwaysFineNoteVol", this.alwaysFineNoteVol ? "true" : "false");
		window.localStorage.setItem("enableChannelMuting", this.enableChannelMuting ? "true" : "false");
		window.localStorage.setItem("displayBrowserUrl", this.displayBrowserUrl ? "true" : "false");
		window.localStorage.setItem("displayVolumeBar", this.displayVolumeBar ? "true" : "false");
		window.localStorage.setItem("fullScreen", this.fullScreen);
		window.localStorage.setItem("colorTheme", this.colorTheme);
		window.localStorage.setItem("customTheme", this.customTheme);
		window.localStorage.setItem("customTheme2", this.customTheme2);
		window.localStorage.setItem("volume", String(this.volume));
	}

	public setVolume(val: number): void {
		this.volume = val;
		this.savePreferences();
		this.synth.volume = this._calcVolume();
	}

	private _calcVolume(): number {
		return Math.min(1.0, Math.pow(this.volume / 50.0, 0.5)) * Math.pow(2.0, (this.volume - 75.0) / 25.0);
	}

	public getCurrentPattern(barOffset: number = 0): Pattern | null {
		return this.song.getPattern(this.channel, this.bar + barOffset);
	}

	public getCurrentInstrument(barOffset: number = 0): number {
		const pattern: Pattern | null = this.getCurrentPattern(barOffset);
		return pattern == null ? 0 : pattern.instrument;
	}

	public getMobileLayout(): boolean {
		return (this.fullScreen == "widefullscreen") ? window.innerWidth <= 1000 : window.innerWidth <= 700;
	}

	public getBarWidth(): number {
		// Bugfix: In wide fullscreen, the 32 pixel display doesn't work as the trackEditor is still horizontally constrained
		return (!this.getMobileLayout() && this.enableChannelMuting && (!this.getFullScreen() || this.fullScreen == "widefullscreen")) ? 30 : 32;
	}

	public getChannelHeight(): number {
		const squashed: boolean = this.getMobileLayout() || this.song.getChannelCount() > 4 || (this.song.barCount > this.trackVisibleBars && this.song.getChannelCount() > 3);
		// TODO: Jummbox widescreen should allow more channels before squashing or megasquashing
		const megaSquashed: boolean = !this.getMobileLayout() && (((this.fullScreen != "widefullscreen") && this.song.getChannelCount() > 11) || this.song.getChannelCount() > 22);
		return megaSquashed ? 23 : (squashed ? 27 : 32);
	}

	public getFullScreen(): boolean {
		return !this.getMobileLayout() && (this.fullScreen != "normal");
	}
}
//}
