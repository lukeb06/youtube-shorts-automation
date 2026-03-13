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

const script = `
I (32 male) work as a cook in a restaurant with an open kitchen, so guest can see us and even talk to us while we work. Two days ago while things were slow a guy walks past our station and asked us for a "favor". He tells us his wife would be walking by in a few minutes and he wanted us to catcall her while she walked past. Stuff like whistling and telling us she looks good.

There are three of us on the stations at the time. Me I'm black, a hispanic guy and a white guy. Before I could even process what he was asking me the white guy speaks up and says " Yeah man, we got you." After the customer left, me and the other cook approached the white cook who had agreed and told him we were not comfortable with what he had agreed to and that we were not going to do it. He got mad and said we already agreed but we reminders him no we didn't he agreed, before he could reply a server came and told us the guys wife was about to walk by. I guess the server who took him to his seat told the other servers what was happening.

A few minutes later his wife walks by and honestly she was gorgeous. She was basically walking like she was on a runway and it was pretty obvious she knew what her husband had asked us to do because she was smiling the whole way to her table, But ony the white cook who had agreed was whistling and cheering. Me and the other just stay quiet and kept working.

Once she sat down, the cook who did it and some of the servers who knew the about the "plan" actually got on our case. They said we were spoilsports and made the whole thing awkward by not joining in. But I just didn't fell comfortable as a Black man catcalling a white woman in a public place and felt it was totally different situation for me than my white coworker.

Now the vibe in the kitchen is weird because they think we were being too serious. Am I the asshole here for just staying silent. 
`.trim().split('\n').map(v => v.trim()).filter(v => !!v).join(' ').trim();

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

async function getCaptions() {
	try {
		await genCaptions();
		
		const raw = await readFile('./captions/output.json', { encoding: 'utf8' });
		const data = JSON.parse(raw);
		if (!data.segments || data.segments.length === 0) return [];
		
		return data.segments.map(s => ({
			type: 'text',
			mode: 'karaoke',
			text: s.text,
			position: s.start,
			end: s.end,
			words: s.words.map(w => ({
				text: w.word,
				start: w.start,
				end: w.start <= w.end ? (w.start + 0.2 > s.end ? w.start <= s.end ? s.end + 0.01 : s.end : w.start + 0.2) : w.end
			})),
			highlightColor: "#00FF00",
			fontSize: 100,
			yPercent: 0.85,
		}));
	} catch (e) {
		console.error(e);
		return [];
	}
}

async function makeVideo() {
	await writeFile('transcript.txt', script);
	
    const project = new sfmpg({ preset: 'youtube-short' });

	const duration = await tts(script, 'audio.mp3');
	
	const captions = await getCaptions();

    await project.load([
        {
            type: 'video',
            url: 'background.mp4',
            volume: 0,
            duration,
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
		...captions
    ]);

    await project.export({
        outputPath: "./video.mp4",
        onProgress: ({ percent }) => {
			if (percent) console.log(`${percent}% complete`)
		},
        preset: 'ultrafast',
		hwaccel: process.env.hardware_accel ?? 'none'
    });
}

makeVideo();
