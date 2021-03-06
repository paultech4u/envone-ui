const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const constants = require('./constants');
const {
  DEFAULT_TOKEN_SECRET, 
  DEFAULT_AUTH_TOKEN,
  DEFAULT_API_PATHS,
  IS_DEBUG_ENABLED,
  DEFAULT_TOKEN_LIFE_TIME
 } = constants;
const {
  formatEnvObjects,
  secretFormat,
  responseRedirect,
  signJwtToken,
  verifyJwtToken,
  getProcessEnv: getProcessEnvFromUtil
} = require('./utils');

let IS_AUTH_REQUIRED = true;

const handleBarsConfig = {
  ATTACH_SCRIPT: fs.readFileSync(path.join(__dirname, './dashboard/index.bundle.js')),
  ATTACH_VARS: `const envData=null`
};

const htmlTemplate = fs
.readFileSync(path.join(__dirname, './dashboard/index.html'))
.toString();

const render = Handlebars.compile(htmlTemplate);

/**
 * Log messages in console
 * @param {*} message 
 */
function logger (message) {
  if (IS_DEBUG_ENABLED) {
    // eslint-disable-next-line no-console
    console.log(`[envone][DEBUG] ${message}`);
  }
}

/**
 * Compile and send the environment dashboard component with the response.
 * @param {*} res 
 */
function sendCompiledEnvDashboard(res, envData) {
  handleBarsConfig.ATTACH_VARS = `const envData=${JSON.stringify(formatEnvObjects(envData))}`;
  return res.send(render(handleBarsConfig));
}

/**
 * Middleware wrapper to expose the data via given APIs
 * @param {*} config - Custom configurations
 */
function configureMiddleware(config = {}) {
  const {
    include = [],
    exclude = [],
    secrets = [],
    configOutput,
    authorizationToken = DEFAULT_AUTH_TOKEN,
    defaultApiPath = DEFAULT_API_PATHS.default,
    dashboardApiPath = DEFAULT_API_PATHS.dashboard,
    isAuthRequired = true,
    tokenSecret = DEFAULT_TOKEN_SECRET,
    tokenLifeTime = DEFAULT_TOKEN_LIFE_TIME
  } = config;

  IS_AUTH_REQUIRED = isAuthRequired;

  let envData;

  if (include) {
    if (Array.isArray(include)) {
      let inclusiveEnvData = {};
      include.forEach(key => {
        if (key in getProcessEnv()){
          inclusiveEnvData[key] =  getProcessEnv()[key];
        }
      });

      envData = inclusiveEnvData;
    } else {
      logger('Invalid type found for "include". It should be a valid array.');
    }
  }

  if (configOutput) {
    if (configOutput.parsed) {
      const envKeys = Object.keys(configOutput.parsed);
      if (envKeys.length > 0) {
        let envOneData = {};
        envKeys.forEach(key => {
          if (key in getProcessEnv()){
            envOneData[key] =  getProcessEnv()[key];
          }
        });
  
        if (envData) {
          envData = { ...envData, ...envOneData };
        } else {
          envData = envOneData;
        }
      } else {
        logger('Empty response from parsed data, Can not find any environment keys.');
      }
    } else {
      logger('Can not find any parsed data from configOutput.');
    }
  }


  if (envData) {
    if (Array.isArray(exclude)) {
      exclude.forEach(key => {
        if (key in envData){
          delete envData[key];
        }
      });
    } else {
      logger('Invalid type found for "exclude". It should be a valid array.');
    } 
    
  
    let secretsArray = [];
    if (configOutput && configOutput.SECRET_ENVIRONMENT_KEYS && Array.isArray(configOutput.SECRET_ENVIRONMENT_KEYS)) {
      secretsArray = secretsArray.concat(configOutput.SECRET_ENVIRONMENT_KEYS);
    }

    if (secrets) {
      if (Array.isArray(secrets)) {
        secretsArray = secretsArray.concat(secrets);
      } else {
        logger('Invalid type found for "secrets". It should be a valid array.');
      } 
    }

    secretsArray.forEach(secretKey => {
      if (secretKey in envData){
        envData[secretKey] = secretFormat(envData[secretKey]);
      }
    });
  }

  /**
   * Custom middle ware function to expose environment variables APIs
   * @param {*} req 
   * @param {*} res 
   * @param {*} next 
   */
  function middleware(req, res, next) {
    var ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    if (!IS_AUTH_REQUIRED) {
      if (req.method.toUpperCase() === "GET" && req.path === dashboardApiPath) {
        return sendCompiledEnvDashboard(res, envData);
      }
    } else {
      if (req.method.toUpperCase() == "POST") {
        if (req.path === DEFAULT_API_PATHS.auth) {
          const { authorization } = req.body;
          if (authorization === authorizationToken) {
            const token = signJwtToken(ipAddress, tokenSecret, tokenLifeTime);
            if (!token.error) {
              return responseRedirect(res, `${dashboardApiPath}?token=${token}`);
            } else {
              return res.status(500).send({ error: 'Can not generate token'});
            }
          } else {
            return res.status(401).send({ error: 'Invalid token'});
          }
        }
      } else if (req.method.toUpperCase() == "GET") {
        if (req.path === DEFAULT_API_PATHS.auth) {
          return responseRedirect(res, `${defaultApiPath}?error=invalid_session`);
        } else if (req.path === defaultApiPath) {
          handleBarsConfig.ATTACH_VARS = `const envData=null`;
          return res.send(render(handleBarsConfig));
        } else if (req.path === dashboardApiPath) {
          
          const { token } = req.query;
          const { ip } = verifyJwtToken(token, tokenSecret);
          if (ip && ip === ipAddress) {
            return sendCompiledEnvDashboard(res, envData);
          } else {
            return responseRedirect(res, `${defaultApiPath}?error=invalid_token`);
          }
        }
      }
    }

    next();
  }

  return middleware;
}

/**
 * EnvOneApi wrapper to process and expose the data
 * @param {*} configuredEnvironmentValues - Configuration output from EnvOne or DotEnv.
 */
function api(configuredEnvironmentValues = {}) {
  return configureMiddleware({ configOutput: configuredEnvironmentValues });
}

function getProcessEnv() {
  return module.exports.retrieveProcessEnv();
}

module.exports.configure = configureMiddleware;
module.exports.api = api;
module.exports.retrieveProcessEnv = getProcessEnvFromUtil;
