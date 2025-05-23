export const HttpResponse = async (statusCode: number, body: any, headers?: Array<any> | null) => {
    let response = {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    };

    if (headers && headers.length > 0) {
        for (let i = 0; i < headers.length; i++) {
            response.headers[headers[i].key] = headers[i].value;
        }
    }
    console.log('Responding with: ', response);
    return response;
};

export default HttpResponse;