require('dotenv').config()

const googleTTS = require('google-tts-api'); // CommonJS
const { default: sfmpg } = require('simple-ffmpegjs');

const https = require('https');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const { writeFile, readFile } = require('node:fs/promises');

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const { default: ollama } = require('ollama');

async function downloadFile(url, destination) {
    const file = fs.createWriteStream(destination);

    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    console.log('File downloaded successfully');
                    resolve(destination);
                });
            });
        }).on('error', (err) => {
            fs.unlink(destination, () => {
                console.error('Error downloading file:', err);
                reject(err);
            });
        });
    });
}

async function downloadAudioFiles(urls) {
    const tempDir = path.join(__dirname, 'temp_audio');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const promises = urls.map((url, i) => {
        const destination = path.join(tempDir, `audio${i}.mp3`);
        return downloadFile(url, destination);
    });

    return await Promise.all(promises);
}

async function concatAudioFiles(audioFiles, outputFile) {
    return new Promise((resolve, reject) => {
        if (audioFiles.length === 0) {
            return reject(new Error('No audio files provided'));
        }

        const command = ffmpeg();

        // Add all inputs
        audioFiles.forEach(file => command.input(file));

        // Build the concat filter dynamically
        // Example: [0:a][1:a][2:a]...concat=n=COUNT:v=0:a=1[outa]
        const filterParts = audioFiles.map((_, i) => `[${i}:a]`).join('');
        const complexFilter = `${filterParts}concat=n=${audioFiles.length}:v=0:a=1[outa]`;

        command
            .complexFilter(complexFilter)
            .outputOptions('-map [outa]')           // map the filtered audio output

            // Re-encode to MP3 (required after filtering)
            .audioCodec('libmp3lame')
            .audioBitrate(64)                       // match your input quality; increase to 96/128 if desired
            .audioFrequency(24000)                  // match input sample rate
            .audioChannels(1)                       // mono

            .format('mp3')                          // ensure MP3 container
            .output(outputFile)

            // Debugging helpers — keep these for now
            .on('start', (cmd) => {
                console.log('FFmpeg command:', cmd);
            })
            .on('progress', (progress) => {
                console.log('Processing:', progress);
            })
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg error:', err.message);
                console.error('stdout:', stdout);
                console.error('stderr:', stderr);
                reject(err);
            })
            .on('end', () => {
                console.log('Concatenation finished:', outputFile);
                resolve(outputFile);
            });

        command.run();
    });
}

async function downloadAndConcatAudioFiles(urls, outputFile) {
    const audioFiles = await downloadAudioFiles(urls);
    return await concatAudioFiles(audioFiles, outputFile);
}

function getURLsForText(text) {
	return text.split('.').map(v => v.trim()).filter(v => !!v).map(v => googleTTS.getAllAudioUrls(v, {
		lang: 'en',
		slow: false,
		host: 'https://translate.google.com',
		splitPunct: ',.?',
	}).map(r => r.url)).flat();
}

async function getAudioDuration(file) {
	const { duration } = await sfmpg.probe(file);
	return duration;
}

async function tts(text, outputFile) {
	const urls = getURLsForText(text);
	await downloadAndConcatAudioFiles(urls, outputFile);
	
	return await getAudioDuration(outputFile);
}

async function genCaptions() {
	console.log('Generating Captions...');
	const cmd = `${__dirname}/captions/.venv/Scripts/python.exe ${__dirname}/captions/main.py`;
	const { stdout, stderr } = await execPromise(cmd);
	console.log(stdout);
    if (stderr) console.warn(stderr);
}

function cleanTitle(text) {
    return text.replaceAll(/[^a-zA-Z0-9]/g, '_');
}

async function genTitle(text) {
    const SYSTEM_PROMPT = "You will be provided with the transcript of a short story. Your task is to generate a SHORT, engaging, clickbait-y title for the short. Your main goal is to drive engagement on the short. Do not include quotations, astericks, or any other special characters besides punctuation and emojis. Do not include extra titling, for example: \"2 Years of Love, 1 Night of Betrayal: My GF Cheated on Me on Our Anniversary 💔💔\" should just be \"My GF Cheated on Me on Our Anniversary 💔💔\"";

    console.log('Generating title...\n')
    const response = await ollama.chat({
        model: 'qwen3:8b',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
        ],
        stream: true,
    });

    let title = "";

    for await (const chunk of response) {
        process.stdout.write(chunk.message.content);
        title += chunk.message.content;
    }

    console.log('\n');

    return title;
}

async function makeVideo() {
	const rawScript = await readFile('./script.txt', { encoding: 'utf8' });
	const script = rawScript.trim().split('\n').map(v => v.trim()).filter(v => !!v).join(' ').trim();
	
	await writeFile('transcript.txt', script);
	
    const project = new sfmpg({ preset: 'youtube-short' });

	const duration = await tts(script, 'audio.mp3');
	
    // await genCaptions();

    await project.load([
        {
            type: 'video',
            url: 'background.mp4',
            volume: 0,
            duration: duration + 1,
        },
        {
            type: 'audio',
            url: 'audio.mp3',
            volume: 1,
            duration,
        },
        {
            type: 'music',
            url: 'music.mp3',
            volume: 0.2,
            loop: true,
        },
        {
            type: 'subtitle',
            url: './captions/output.ass',
            position: 0,
        }
    ]);

    const title = await genTitle(script);

    await project.export({
        outputPath: `${cleanTitle(title)}.mp4`,
        onProgress: ({ percent }) => {
			if (percent) console.log(`${percent}% complete`)
		},
        preset: 'ultrafast',
		hwaccel: process.env.hardware_accel ?? 'none',
        metadata: {
            title,
        }
    });
}

makeVideo();
