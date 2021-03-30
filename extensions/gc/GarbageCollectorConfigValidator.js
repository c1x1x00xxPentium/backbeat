const joi = require('@hapi/joi');
const { zenkoAuthJoi, retryParamsJoi } =
    require('../../lib/config/configItems.joi.js');

const joiSchema = joi.object({
    topic: joi.string().required(),
    auth: zenkoAuthJoi.required(),
    consumer: {
        groupId: joi.string().required(),
        retry: retryParamsJoi,
        concurrency: joi.number().greater(0).default(10),
    },
});

function configValidator(backbeatConfig, extConfig) {
    const validatedConfig = joi.attempt(extConfig, joiSchema);
    return validatedConfig;
}

module.exports = configValidator;
