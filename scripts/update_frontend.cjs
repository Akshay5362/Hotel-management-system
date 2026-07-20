const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'guest-web', 'src', 'components', 'GuestBookingWizard.jsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Ensure razorpay script is loaded.
// Instead of messing with React lifecycle, let's just append it to index.html
const htmlPath = path.join(__dirname, 'guest-web', 'index.html');
let htmlContent = fs.readFileSync(htmlPath, 'utf8');
if (!htmlContent.includes('checkout.razorpay.com')) {
  htmlContent = htmlContent.replace('</head>', '  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>\n  </head>');
  fs.writeFileSync(htmlPath, htmlContent);
}

// 2. Modify handleBookSubmit signature to accept transactionId
const oldHandleSubmit = `  const handleBookSubmit = async () => {`;
const newHandleSubmit = `  const handleBookSubmit = async (transactionId = null) => {`;
content = content.replace(oldHandleSubmit, newHandleSubmit);

// 3. Add paymentMethod and transactionId to the payload
const oldPayload = `          extraServices
        })`;
const newPayload = `          extraServices,
          paymentMethod,
          transactionId
        })`;
content = content.replace(oldPayload, newPayload);

// 4. Update the "Confirm Booking" click handler to intercept Razorpay
const oldButton = `                    onClick={handleBookSubmit}`;
const newButton = `                    onClick={async () => {
                      if (paymentMethod === 'Online') {
                        setIsSubmitting(true);
                        try {
                          // 1. Get Order ID
                          const res = await fetch(\`http://localhost:5000/api/payments/razorpay/order\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
                            body: JSON.stringify({ amount: parseInt(paymentDeposit, 10) })
                          });
                          const data = await res.json();
                          if (!res.ok) throw new Error(data.error || 'Failed to create order');

                          // 2. Open Razorpay
                          const options = {
                            key: data.key_id,
                            amount: data.amount,
                            currency: data.currency,
                            name: 'Hotel PMS',
                            description: 'Room Reservation Deposit',
                            order_id: data.order_id,
                            handler: async function (response) {
                              try {
                                // 3. Verify Payment
                                const verifyRes = await fetch(\`http://localhost:5000/api/payments/razorpay/verify\`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
                                  body: JSON.stringify({
                                    razorpay_order_id: response.razorpay_order_id,
                                    razorpay_payment_id: response.razorpay_payment_id,
                                    razorpay_signature: response.razorpay_signature
                                  })
                                });
                                const verifyData = await verifyRes.json();
                                if (!verifyRes.ok) throw new Error(verifyData.error || 'Verification failed');
                                
                                // 4. Book Room
                                await handleBookSubmit(verifyData.transaction_id);
                              } catch (err) {
                                showAlert(err.message, 'Payment Verification Failed');
                                setIsSubmitting(false);
                              }
                            },
                            prefill: {
                              name: guestName,
                              email: guestEmail,
                              contact: guestPhone
                            },
                            theme: {
                              color: '#38bdf8'
                            },
                            modal: {
                              ondismiss: function() {
                                setIsSubmitting(false);
                              }
                            }
                          };
                          const rzp = new window.Razorpay(options);
                          rzp.open();
                        } catch (err) {
                          showAlert(err.message, 'Payment Initialization Failed');
                          setIsSubmitting(false);
                        }
                      } else {
                        handleBookSubmit();
                      }
                    }}`;
content = content.replace(oldButton, newButton);

fs.writeFileSync(filePath, content);
console.log("Frontend Razorpay checkout integrated.");
