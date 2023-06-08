'use strict'; // eslint-disable-line

const async = require('async');

const { errors } = require('arsenal');
const ObjectMD = require('arsenal').models.ObjectMD;

const { LifecycleMetrics } = require('../LifecycleMetrics');
const { LifecycleRequeueTask } = require('./LifecycleRequeueTask');

class LifecycleResetTransitionInProgressTask extends LifecycleRequeueTask {
    /**
     * Process a lifecycle object entry
     *
     * @constructor
     * @param {LifecycleObjectProcessor} proc - object processor instance
     */
     constructor(proc) {
        const procState = proc.getStateVars();
        super();
        Object.assign(this, procState);
    }

    requeueObjectVersion(accountId, bucketName, objectKey, objectVersion, etag, try_, bucketLogger, cb) {
        const client = this.getBackbeatMetadataProxy(accountId);
        if (!client) {
            return cb(errors.InternalError.customizeDescription(
                `Unable to obtain client for account ${accountId}`,
            ));
        }

        const params = {
            bucket: bucketName,
            objectKey,
        };
        if (objectVersion) {
            params.versionId = objectVersion;
        }

        const log = this.logger.newRequestLogger(bucketLogger.getUids());
        log.addDefaultFields({
            accountId,
            bucketName,
            objectKey,
            objectVersion,
            etag,
            try: try_,
        });

        return client.getMetadata(params, log, (err, blob) => {
            LifecycleMetrics.onS3Request(log, 'getMetadata', 'transition', err);
            if (err) {
                return cb(err);
            }

            const { result: md, error } = ObjectMD.createFromBlob(blob.Body);
            if (error) {
                return cb(error);
            }

            if (this.shouldSkipObject(md, etag, log)) {
                return cb(null, 0);
            }

            md.setTransitionInProgress(false);
            md.setUserMetadata({
                'x-amz-meta-scal-s3-transition-attempt': try_,
            });

            return client.putMetadata({ ...params, mdBlob: md.getSerialized() }, log,
                err => {
                    LifecycleMetrics.onS3Request(log, 'putMetadata', 'transition', err);
                    if (err) {
                        return cb(err);
                    }

                    return cb(null, 1);
                }
            );
        });
    }

    shouldSkipObject(md, expectedEtag, log) {
        try {
            const etag = JSON.parse(expectedEtag);
            if (etag !== md.getContentMd5()) {
                log.debug('different etag, skipping object', {
                    currentETag: md.getContentMd5(),
                    requeueEtag: etag,
                });
                return true;
            }
        } catch (error) {
            log.error('unparseable etag, skipping object', { errorMessage: error.message });
            return true;
        }

        if (!md.getTransitionInProgress()) {
            log.debug('not transitioning, skipping object');
            return true;
        }

        return false;
    }
}

module.exports = {
    LifecycleResetTransitionInProgressTask
};
