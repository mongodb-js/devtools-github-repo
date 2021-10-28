## Download center tools

Provides a set of functions to aid releases to the download center.

### Features

- Pre-configured ACLs
- Upload and download assets
- Validates and uploads product configurations
- Checks for broken urls in configurations

### Usage

#### Create a new DownloadCenter instance

``` js
import { DownloadCenter } from '@mongodb-js/github-repo';

const bucketConfig = {
  bucket: `${process.env.MONGODB_DOWNLOADS_BUCKET_NAME}`,
  accessKeyId: `${process.env.MONGODB_DOWNLOADS_AWS_ACCESS_KEY_ID}`,
  secretAccessKey: `${process.env.MONGODB_DOWNLOADS_AWS_SECRET_ACCESS_KEY}`
};

const downloadCenter = new DownloadCenter(bucketConfig);
```

#### Validate and upload a configuration

`downloadCenter.uploadConfig` validates a configuration against a [json schema](https://github.com/mongodb-js/download-center/blob/main/src/download-center-config.schema.json), checks that all the download links are reacheable and uploads the configuration to the download center.

``` js
const compassConfig = {
  versions: [ /* ... */ ],
  // ...
};

await downloadCenter.uploadConfig('compass/compass.json', compassConfig);
```

#### Download a configuration

``` js
const config = await downloadCenter.downloadConfig('compass/compass.json');
assert(config.versions.length > 1);
```

#### Upload an asset

``` js
const config = await downloadCenter.uploadAsset(
  'compass/assets/compass.tgz',
  fs.createReadStream('./compass.tgz'),
  { contentType: 'application/gzip' } // contentType is optional
);
```

#### Download an asset

``` js
const buffer = await downloadCenter.downloadAsset(
  'compass/assets/compass.tgz'
);

fs.writeFileSync('./compass.tgz', buffer);
```

#### Validates a configuration without uploading it

``` js
import { validateConfig } from '@mongodb-js/github-repo';

await validateConfig({ /* ... */ });
```

#### Wait for assets upload

This can be used to wait for the assets of a release to be available before
publishing a new configuration:

``` js
const { ok, status } = await probePlatformDownloadLink(platform);
```
