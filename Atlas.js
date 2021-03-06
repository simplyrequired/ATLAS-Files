const Sentry = require('@sentry/node');
const path = require('path');
const Eris = require('eris');
const flatten = require('flat');
const fs = require('fs').promises;

const lib = require('atlas-lib');
const Util = require('./src/util');
const Agenda = require('./src/agenda');
const loader = require('./src/commands');
const structs = require('./src/structures');
const constants = require('./src/constants');
const Database = require('./src/structures/Database');
const ActionsInterval = require('./src/actionsInterval');

const { version } = require('./package.json');

// load eris addons cus lazy
const addons = require('./src/addons');

Object.keys(addons).forEach((a) => {
	Object.values(addons[a]).forEach((Prop) => {
		Prop(Eris);
	});
});

module.exports = class Atlas {
	constructor({
		client,
	}) {
		module.exports = this;

		this.version = version;
		this.userAgent = `Atlas (https://github.com/atlasbot/bot, ${version})`;

		this.client = client;
		this.auditOverrides = [];
		// an array of ID's for things like roles where if a member gets it the event should be ignored
		// used for things like overriding the action log for "mute" to show more info
		this.ignoreUpdates = [];

		this.Sentry = Sentry;
		this.structs = structs;

		this.util = (new Util(this));

		this.constants = constants;
		this.colors = constants.colors;

		// messages sent by the responder
		this.sent = [];

		this.commands = {
			labels: new Map(),
			aliases: new Map(),
			get(label) {
				return this.labels.get(label) || this.labels.get(this.aliases.get(label));
			},
			has(label) {
				return this.labels.has(label) || this.aliases.has(label);
			},
		};

		this.eventHandlers = new Map();
		this.locales = new Map();
		this.filters = new Map();
		this.plugins = new Map();
		this.agenda = new Agenda();

		this.DB = new Database();

		this.collectors = {
			emojis: {
				map: {},
				get: id => this.collectors.emojis.map[id],
				delete: (id, collector) => {
					if (this.collectors.emojis.map[id]) {
						const index = this.collectors.emojis.map[id].findIndex(c => c === collector);
						if (this.collectors.emojis.map[id][index]) {
							return !!this.collectors.emojis.map[id].splice(index);
						}
					}
				},
				add: (id, collector) => {
					if (this.collectors.emojis.map[id]) {
						this.collectors.emojis.map[id].push(collector);
					} else {
						this.collectors.emojis.map[id] = [collector];
					}
				},
			},
		};

		// when a message ID matching the key is deleted, delete the map value (another ID)
		this.deleteAliases = new Map();

		this.version = require('./package.json').version;

		this.lib = lib;
		this.env = process.env.NODE_ENV || 'development';
		this.actionsInterval = new ActionsInterval(this);

		// whether this shard is the master shard
		this.master = client.options.firstShardID === 0;
	}

	// im lazy
	/**
	 * gets the bot's avatar URL
	 */
	get avatar() {
		return this.client.user.avatarURL;
	}

	async launch() {
		if (!process.env.SENTRY_DSN) {
			console.warn('Error reporting disabled, set SENTRY_DSN to enable it.');
		}

		// setting up sentry for error tracking when possible
		// if no SENTRY_DSN is provided sentry will will still "work"
		Sentry.init({
			dsn: process.env.SENTRY_DSN,
			debug: process.env.NODE_ENV === 'development',
			release: require('./package.json').version,
			environment: process.env.NODE_ENV,
			maxBreadcrumbs: 5,
			// discord has "hiccups" where everything breaks and things time out which we can't do shit about
			ignoreErrors: [
			// should match "Gateway Time-out on xxx"
				'Time-out on',
				// should match "Request timed out (>Nms) on METHOD"
				'Request timed out (',
				// should match "DiscordHTTPError: 500 INTERNAL SERVER ERROR on POST xxx"
				'500 INTERNAL SERVER ERROR on',
			],
		});

		process.on('unhandledRejection', (reason) => {
			console.warn(reason);
		});

		process.on('uncaughtException', async (err) => {
			console.warn(err);
		});

		const events = await fs.readdir('src/events');
		// Loading events
		events.forEach((e) => {
			const Handler = require(`./src/events/${e}`);
			const handler = new Handler(this);

			const name = e.split('.')[0];

			this.eventHandlers.set(name, handler);
			this.client.on(name, handler.execute.bind(handler));

			delete require.cache[require.resolve(`./src/events/${e}`)];

			console.log(`Loaded event handler: "${e}"`);
		});

		const filters = await fs.readdir('src/filters');
		filters.forEach((f) => {
			const Filter = require(`./src/filters/${f}`);
			const filter = new Filter(this);

			filter.info = Filter.info;

			this.filters.set(f.split('.')[0], filter);

			console.log(`Loaded chat filter: "${f}"`);
		});

		console.log(`Loaded ${filters.length} filters`);

		console.log(`Loaded ${events.length} events`);

		await this.loadLocales();

		console.log(`Loaded ${this.locales.size} languages`);
		// load commands
		loader.setup(this);
	}

	async loadLocales() {
		const sourceFiles = await fs.readdir('./locales/source');
		const translatedFiles = await fs.readdir('./locales/translated');

		const loadLocale = (dir, files) => {
			const locale = {};

			for (const file of files) {
				const d = require(`./locales/${dir}/${file}`);

				if (d) {
					locale[path.basename(file).split('.').shift()] = d;
				}
			}

			return flatten(locale, {
				safe: true,
			});
		};

		const en = loadLocale('source', sourceFiles);

		for (const locale of translatedFiles) {
			const flattened = loadLocale(`translated/${locale}`, sourceFiles);

			this.locales.set(locale, {
				data: {
					...en,
					...flattened,
				},
				code: locale,
			});
		}

		this.locales.set('en', {
			data: en,
			code: 'en',
		});
	}
};
