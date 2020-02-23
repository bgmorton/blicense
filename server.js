
'use strict';

// Load config before anything else
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const { Sequelize, Model, DataTypes } = require('sequelize');
const fs = require("fs");
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const expressWinston = require('express-winston');
const errorHandler = require('strong-error-handler');
const countryList = require('country-list');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const math = require('mathjs');
const licenseFile = require('nodejs-license-file');

// Logger for email send issues
const mailLogger = winston.createLogger({
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: path.join(__dirname, 'logs', "mail_error.log"),
            maxSize: 2048,
            maxFiles: parseInt(process.env.LOGS_MAX_FILES),
        }),
    ]
});

//Logger for DB init issues
const dbLogger = winston.createLogger({
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: path.join(__dirname, 'logs', "db_error.log"),
            maxSize: 2048,
            maxFiles: parseInt(process.env.LOGS_MAX_FILES),
        }),
    ]
});

//License Template
const template = fs.readFileSync(path.join(__dirname, "license_template.txt"), "utf-8");

// DB
const sequelize = new Sequelize(process.env.MYSQL_DB, process.env.MYSQL_USER, process.env.MYSQL_PASSWORD, {
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT),
    dialect: 'mysql',
    retry: {
        max: 5,
    }
});

// DB Model
class License extends Model { };
License.init({
    name: DataTypes.STRING,
    email: DataTypes.STRING,
    expires: DataTypes.DATE,
    license: DataTypes.TEXT,
    invoice: DataTypes.TEXT,
    transaction_ref: DataTypes.STRING,
}, { sequelize, modelName: 'license' });

// DB Connect
async function createConnection() {
    try {
        await sequelize.authenticate();// Connect to the DB
        await sequelize.sync({ alter: true });// Alter the DB to match model fields
        console.log('Connection has been established successfully.');
    } catch (error) {
        dbLogger.error(error);
        console.log('Retrying...');
        createConnection();// Connection will continue retrying after the application has launched if no success
    }
}

// Http App
const app = express();

// Parse incoming request bodies in a middleware before your handlers, available under the req.body property
app.use(bodyParser.urlencoded({ extended: true }));

// Sessions
const fileStoreOptions = {};
app.use(session({
    store: new FileStore(fileStoreOptions),
    secret: process.env.APP_SECRET
}));

// Set express to render the ejs files as html
app.set('view engine', 'ejs');
app.engine('html', require('ejs').renderFile);

// Check the database status on each request so the user can be halted if it's stopped
function testConnection() {
    return sequelize.authenticate();
}
app.use(function (req, res, next) {
    return testConnection().then(() => {
        next();
    }).catch(error => {
        next(error);
    });
});

// Static assets
app.use(express.static(path.join(__dirname, 'views', 'static')));

// Index page 
app.get('/', function (req, res) {
    let data = { countries: countryList.getNames() };
    if (req.session.validation_errors) {
        data['validation_errors'] = req.session.validation_errors;
        //Reset the session to clear errors
        req.session.regenerate(function (error) {
            res.render('pages/index', data);
        });
    }
    else {
        res.render('pages/index', data);
    }
});

// Redirect if charge page is accessed not via form submit
app.get('/charge', function (req, res) {
    res.redirect('/');
});

// Completed page.  Resets the session as the job is done
app.get('/completed', function (req, res, next) {
    if (!req.session.invoiceText) {
        //Redirect if no data, ie the user has refreshed or navigated here manually
        res.redirect('/');
    } else {
        let invoiceText = req.session.invoiceText;
        req.session.regenerate(function (error) {
            if (error) next(error);
            res.render("pages/completed", { invoiceText: invoiceText });
        });
    }
});

//Form submit function
app.post("/charge", [
    // Validate
    body('stripeToken')
        .exists()
        .not().isEmpty()
        .trim()
        .escape(),
    body('duration')
        .exists()
        .isInt()
        .isIn(['6', '12', '24']),
    body('emailConfirm')
        .exists()
        .custom((value, { req }) => value === req.body.email),
    body('email')
        .exists()
        .isEmail(),
    body('name')
        .exists()
        .not().isEmpty()
        .trim()
        .escape(),
    body('country')
        .exists()
        .isIn(countryList.getNames()),
    body('total')
        .exists()
        .custom((value, { req }) => {
            // Confirm the total hasn't been tampered with and matches what the user expects

            // Calculate the total
            let STRIPE_CURRENCY = process.env.STRIPE_CURRENCY;
            let STRIPE_CURRENCY_SYMBOL = process.env.STRIPE_CURRENCY_SYMBOL;
            let STRIPE_GST_PERCENT = Number(process.env.STRIPE_GST_PERCENT);
            let STRIPE_GST_COUNTRY = process.env.STRIPE_GST_COUNTRY;
            let LICENSE_PRICE_PER_MONTH = Number(process.env.LICENSE_PRICE_PER_MONTH);
            let LICENSE_DISCOUNT_PER_ADDITIONAL_MONTH_PERCENTAGE = Number(process.env.LICENSE_DISCOUNT_PER_ADDITIONAL_MONTH_PERCENTAGE);
            let LICENSE_DISCOUNT_PER_ADDITIONAL_MONTH_PERCENTAGE_MAX = Number(process.env.LICENSE_DISCOUNT_PER_ADDITIONAL_MONTH_PERCENTAGE_MAX);

            let months = parseInt(req.body.duration);
            let country = req.body.country;

            let confirmTotal = 0;
            let taxAmount = 0;

            let discountFromAdditionalMonths = math.chain((months - 1)).multiply(LICENSE_DISCOUNT_PER_ADDITIONAL_MONTH_PERCENTAGE).done(); //Subtract one from months as there should be no discount on the first month
            if (discountFromAdditionalMonths > LICENSE_DISCOUNT_PER_ADDITIONAL_MONTH_PERCENTAGE_MAX) discountFromAdditionalMonths = LICENSE_DISCOUNT_PER_ADDITIONAL_MONTH_PERCENTAGE_MAX;//Discount cannot be more than max
            discountFromAdditionalMonths = math.chain(discountFromAdditionalMonths).divide(100).done();
            confirmTotal += math.chain(LICENSE_PRICE_PER_MONTH).multiply(months).done();
            confirmTotal -= math.chain(discountFromAdditionalMonths).multiply(confirmTotal).done();

            // Apply tax if required
            taxAmount = country == STRIPE_GST_COUNTRY ? math.chain(STRIPE_GST_PERCENT).divide(100).multiply(confirmTotal).done() : 0;

            // Store the gst amount for later use in the invoice
            req.body.gst = math.round(taxAmount, process.env.STRIPE_CURRENCY_DECIMALS);
            // Store the total sans gst for later use in the invoice
            req.body.priceNoGst = math.round(confirmTotal, process.env.STRIPE_CURRENCY_DECIMALS);

            // Confirm the totals match
            confirmTotal = math.round(math.chain(confirmTotal).add(taxAmount).done(), process.env.STRIPE_CURRENCY_DECIMALS);

            //Format the total while validating 
            req.body.total = math.round(value, process.env.STRIPE_CURRENCY_DECIMALS);

            return value == confirmTotal;
        }),
    body('termsAccepted').toBoolean(),// Converts checkbox to boolean
], (req, res, next) => {

    // Finds the validation errors in this request and wraps them in an object with handy functions
    const validateErrors = validationResult(req);
    if (!validateErrors.isEmpty()) {
        // Redirect to show validation errors, don't just output the page, so the user can't refresh to resubmit the form
        req.session.validation_errors = validateErrors.array();
        return res.redirect('/');
    }

    //Data for creating the license
    let initialLicenseData = {
        license_version: 1,
        created: new Date().toDateString(),
        expires: new Date(new Date().setMonth(new Date().getMonth() + parseInt(req.body.duration))).toDateString(),//license duration
    };

    return stripe.customers
        .create({
            name: req.body.name,
            email: req.body.email,
            source: req.body.stripeToken
        })
        .then(customer => {
            return stripe.charges.create({
                amount: math.round(math.chain(Number(req.body.total)).multiply(100).done()),
                currency: process.env.STRIPE_CURRENCY,
                customer: customer.id
            }).then(charge => {

                //Add submitted data to license for generation
                let licenseData = {
                    ...initialLicenseData, ...{
                        customer_name: req.body.name,
                        email: req.body.email,
                    }
                };

                // Generate the license
                let licenseFileContent = licenseFile.generate({
                    privateKeyPath: path.join(__dirname, '.license_private_key.pem'),
                    template,
                    data: licenseData,
                });

                // Generate the invoice
                let invoiceText = [
                    'Hi ' + req.body.name + ',',
                    '',
                    'Thank you for your purchase.',
                    '',
                    '',
                    // Invoice
                    '----------',
                    'YOUR TAX INVOICE',
                    '----------',
                    '',
                    'Transaction Reference: ' + charge.id,
                    'Country: ' + req.body.country,
                    '',
                    '1x ' + req.body.duration + ' months software license for ' + process.env.PRODUCT_NAME + ' - ' + process.env.STRIPE_CURRENCY_SYMBOL + req.body.priceNoGst.toFixed(process.env.STRIPE_CURRENCY_DECIMALS),
                    req.body.gst ? (process.env.STRIPE_GST_PERCENT + '% ' + process.env.STRIPE_GST_NAME + ' - ' + process.env.STRIPE_CURRENCY_SYMBOL + req.body.gst.toFixed(process.env.STRIPE_CURRENCY_DECIMALS)) : '',// Tax row only if tax present
                    '',
                    'Total: ' + process.env.STRIPE_CURRENCY_SYMBOL + req.body.total.toFixed(process.env.STRIPE_CURRENCY_DECIMALS),
                    '',
                    '',
                    // License details
                    '----------',
                    'Copy and paste the below license into your application to apply it.',
                    '----------',
                    '',
                    licenseFileContent,
                ].join('\n');

                //Save license in DB with additional details
                let license = new License({
                    name: req.body.name,
                    email: req.body.email,
                    expires: licenseData.expires,
                    license: licenseFileContent,
                    invoice: invoiceText,
                    transaction_ref: charge.id
                });

                return license.save().then(() => {

                    //Email the license
                    let transporter = nodemailer.createTransport({
                        host: process.env.SMTP_HOST,
                        port: process.env.SMTP_PORT,
                        secure: process.env.SMTP_SECURE == 'true' ? true : false,
                        auth: {
                            user: process.env.SMTP_USER,
                            pass: process.env.SMTP_PASSWORD
                        }
                    });

                    let mailOptions = {
                        from: {
                            name: process.env.SMTP_FROM_NAME,
                            address: process.env.SMTP_FROM,
                        },
                        to: req.body.email,
                        subject: 'Your ' + process.env.PRODUCT_NAME + ' License',
                        text: invoiceText
                    };

                    transporter.sendMail(mailOptions).then(() => {

                        // Redirect to completed page.  Don't just show the completed view to avoid form resubmit if the user refreshes.
                        // Will need to store email text in the session for display in completed view
                        req.session.invoiceText = invoiceText;
                        res.redirect('/completed');

                    }).catch(mailError => {

                        //Log the error, show the response anyway so the user gets their license

                        mailLogger.error(mailError);

                        // Redirect to completed page.  Don't just show the completed view to avoid form resubmit if the user refreshes.
                        // Will need to store email text in the session for display in completed view
                        req.session.invoiceText = invoiceText;
                        res.redirect('/completed');

                    });

                });

            });
        })
        .catch(error => {
            next(error);
        });

});

// Handle Errors
app.use(expressWinston.errorLogger({
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: path.join(__dirname, 'logs', "http_error.log"),
            maxSize: 2048,
            maxFiles: parseInt(process.env.LOGS_MAX_FILES),
        }),

    ],
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.json(),
    )
}));

// Error Responses - should go last
app.use(errorHandler({
    debug: app.get('env') === 'development',
    log: false,
}));

// Start it up
createConnection().then(() => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log('Server is running...'));
});