// Load dependencies
const aws = require('aws-sdk')
const express = require('express')
require('dotenv').config()
var path = require('path')
var mime = require('mime-types')
var fs = require('fs'), request = require('request')
var download = require('download-file')
const console = require('better-console')
const argv = require('minimist')(process.argv.slice(2))

aws.config.update({
    accessKeyId: process.env.do_key_id,
    secretAccessKey: process.env.do_secret_key
});

const spacesEndpoint = new aws.Endpoint(process.env.do_endpoint);
const s3 = new aws.S3({
    endpoint: spacesEndpoint
});

const localfolder = argv.f

var SpaceObj = []
var Disk = []

async function syncSpace(cb) {
    var params = { Bucket: process.env.do_space }
    SpaceObj = []
    let IsTruncated = true
    let cToken = ''
    console.log('Reading from Space...')
    while (IsTruncated) {
        if (cToken !== '') { params.ContinuationToken = cToken }
        console.log('Fetching bucket.')
        let res = await readSpace(params)
        if (res === false) {
            IsTruncated = false
        } else {
            cToken = res
        }
    }
    cb(SpaceObj)
}

async function readSpace(params) {
    return new Promise(response => {
        s3.listObjectsV2(params, function (err, data) {
            if (err) {
                console.log(err)
            } else {
                SpaceObj = SpaceObj.concat(data.Contents);
                if (data.IsTruncated) {
                    console.log('Truncated, iterating through bucket.')
                    cToken = data.NextContinuationToken
                    response(cToken)
                } else {
                    console.log('Data finished, callbacking function.')
                    response(false)
                }
            }
        });
    })
}

function readDisk(mainfolder) {
    return new Promise(async response => {
        await readFolder(mainfolder)
        setTimeout(function () {
            response(Disk)
        }, 500)
    })
}

function readFolder(folder) {
    return new Promise(response => {
        let ff = []
        fs.readdir(folder, function (err, files) {
            //handling error
            if (err) {
                return console.log('Unable to scan directory: ' + err);
            }
            // searching for subdirectories
            files.forEach(function (file, index) {
                var folderPath = path.join(folder, file);
                fs.stat(folderPath, async function (error, stat) {
                    if (error) {
                        console.error("Error stating file.", error);
                        return;
                    }
                    if (stat.isFile() === false) {
                        console.log('Reading folder ' + folderPath)
                        let subfolder = await readFolder(folderPath)
                        if (subfolder.length > 0) {
                            if (Disk.indexOf(subfolder.replace(localfolder + '/', '')) === -1) {
                                Disk.push(subfolder.replace(localfolder + '/', ''))
                            }
                        }
                    } else {
                        if (Disk.indexOf(folder.replace(localfolder, '') + '/' + file) === -1) {
                            Disk.push(folder.replace(localfolder, '') + '/' + file)
                        }
                    }
                })
            })
            setTimeout(function () {
                response(ff)
            }, 5000)
        })
    })
}

function uploadToSpace(file) {
    return new Promise(response => {
        try {
            let type = mime.lookup(localfolder + '/' + file)
            if (type !== '' && type.length > 0) {
                console.log('Uplading to ' + localfolder.replace('./', '/') + file)
                s3.upload({
                    Bucket: process.env.do_space,
                    ACL: 'public-read',
                    Body: fs.createReadStream(localfolder + '/' + file),
                    Key: localfolder.replace('./', '') + file,
                    ContentType: type
                }, { Bucket: process.env.do_space }, function (err, data) {
                    if (err) {
                        console.log(err)
                        response(false)
                    }
                    console.log(data)
                    response(true)
                })
            } else {
                response(true)
            }
        } catch (e) {
            console.log(file + ' not uploaded, retry.', e)
            response(false)
        }
    })
}

function downloadFromSpace(spaceFile) {
    return new Promise(response => {
        try {
            var url = "https://" + process.env.do_space + "." + process.env.do_endpoint + spaceFile.replace('./', '/')
            let xpl = spaceFile.split('/')
            let lastchunk = xpl.length - 1
            let folder = spaceFile.replace(xpl[lastchunk], '')
            console.log('Remote file ' + url + ' downloading in ' + folder + xpl[lastchunk])
            var options = {
                directory: folder,
                filename: xpl[lastchunk]
            }

            download(url, options, function (err) {
                if (err) {
                    console.log(err)
                    response(false)
                } else {
                    console.log("Downloaded correctly.")
                    response(true)
                }
            })
        } catch (e) {
            console.log('Downloading error.')
            response(false)
        }
    })
}

async function syncAll() {
    await readDisk(localfolder)
    fs.writeFileSync('Disk', JSON.stringify(Disk));
    syncSpace(async function (Space) {
        console.log('Space have ' + Space.length + ' files')
        let SpaceFiles = []
        for (let x in Space) {
            let spaceFile = Space[x]
            SpaceFiles.push(spaceFile.Key.replace(localfolder.replace('.', ''), ''))
        }
        fs.writeFileSync('Space', JSON.stringify(SpaceFiles));

        for (let x in SpaceFiles) {
            let spaceFile = SpaceFiles[x]
            let normalized = './' + spaceFile
            normalized = normalized.replace(localfolder, '')
            console.log('Checking ' + normalized)
            let last = normalized.substr(-1)
            if (Disk.indexOf(normalized) === -1 && last !== '/') {
                console.log('Downloading ' + spaceFile + ' into disk')
                let downloaded = false
                let retries = 0
                while (downloaded === false) {
                    downloaded = await downloadFromSpace(normalized)
                    if (downloaded === true) {
                        console.info(spaceFile + ' downloaded correctly.')
                    }
                    retries++
                    if (retries >= 5) {
                        downloaded = true
                        console.error('Error on download')
                    }
                }
            } else {
                console.error(normalized + ' exists in Disk')
            }
        }

        for (let x in Disk) {
            let localFile = localfolder.replace('./', '') + Disk[x]
            if (SpaceFiles.indexOf(localFile) === -1 && localFile.indexOf('image_here') === -1) {
                console.log('Need to upload ' + localFile)
                let uploaded = false
                while (uploaded === false) {
                    uploaded = await uploadToSpace(localFile)
                }
                console.info(localFile + ' uploaded correctly.')
            } else {
                console.error(localFile + ' uploaded yet.')
            }
        }

        console.log('Sync done, waiting 2s then restart')
        setTimeout(function () {
            syncAll()
        }, 2000)
    })
}

syncAll()