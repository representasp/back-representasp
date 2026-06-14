const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

// Função de Construção de Query String conforme Log [#53, #109]
function buildTargetQuery(rooms, categoryIds, nmNick) {
    const params = new URLSearchParams();

    // 1. IDs das salas base
    rooms.forEach(r => {
        if (r.name) params.append('publication_target', r.name);
    });

    // 2. Alvos específicos com o Nick (Formato SALA:NICK-sp)
    if (nmNick) {
        rooms.forEach(r => {
            if (r.name) params.append('publication_target', `${r.name}:${nmNick}-sp`);
        });
    }

    // 3. IDs de categorias globais
    categoryIds.forEach(id => {
        if (id) params.append('publication_target', id.toString());
    });

    // Retorna com o "&" prefixado para encaixar no "?&" ou no meio da URL
    return `&${params.toString()}`;
}

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [BFF GATEWAY INTEGRADO V2] CONECTANDO EM MODO ULTRA: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. AUTENTICAÇÃO CENTRALIZADA (SED)
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const raCompletoFormatado = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();
        
        // Coleta do Login Name / Nick do aluno para os alvos da IP.TV
        const nmNick = dadosUsuario.LOGIN; 

        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        };

        // ----------------------------------------------------------
        // 2. EXTRAÇÃO DA DATA DE CORTE DO BIMESTRE (SED)
        // ----------------------------------------------------------
        let infoTurma = {};
        let schoolId = null;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data) && turmaRes.data.length > 0) infoTurma = turmaRes.data[0];
            else if (turmaRes.data?.data) infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            schoolId = infoTurma?.CodigoEscola || infoTurma?.CD_ESCOLA;
        } catch (err) { console.error(`[BFF] Erro Turma: ${err.message}`); }

        let dataInicioBimestre = new Date("2026-04-23T00:00:00Z"); // Fallback cronológico do log
        if (schoolId) {
            try {
                const bimestreRes = await axios.get(`${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Bimestre/ListarBimestres?escolaId=${schoolId}`, sedConfig);
                const listaBimestres = bimestreRes.data?.data || bimestreRes.data || [];
                if (Array.isArray(listaBimestres)) {
                    const bAtivo = listaBimestres.find(b => b.Ativo === true || b.NumeroBimestre === 2);
                    if (bAtivo?.DataInicio) {
                        dataInicioBimestre = new Date(bAtivo.DataInicio);
                    }
                }
            } catch (errBim) { console.error(`[BFF] Erro Calendário: ${errBim.message}`); }
        }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV PROTOCOLO DE ACESSO
        // ----------------------------------------------------------
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                { httpsAgent, headers: { 'x-api-realm': 'edusp', 'x-api-platform': 'webclient', 'Content-Type': 'application/json' }}
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (err) { console.error(`[BFF] Erro Handshake IP.TV: ${err.message}`); }

        // ----------------------------------------------------------
        // 4. CHAMADAS MATRICIAIS BASEADAS NOS LOGS (STATUS 200)
        // ----------------------------------------------------------
        let pendentes = 0;
        let expiradas = 0;
        let avaliacoes = 0;
        let redacoes = 0;

        if (authTokenIptv) {
            try {
                // Header Host injetado cirurgicamente para evitar o 404 do Nginx
                const configIptvBase = {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Host': 'edusp', 
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                };

                // Puxar as salas para alimentar a função geradora de queries
                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                const allCategories = [...new Set(rooms.flatMap(r => r.category_ids || []))];
                
                // Geração da cauda de parâmetros idêntica ao aplicativo
                const targetQuery = buildTargetQuery(rooms, allCategories, nmNick);

                // Disparo em lote com a ordem exata e o "?&" estrutural mapeado
                const [surveyRes, pendentesRaw, expiradasRaw, redacoesRaw] = await Promise.all([
                    // Rota das Pesquisas (Card Avaliações) [Log 53]
                    axios.get(`${CONSTANTS.BASE_IPTV}/survey/todo/count?${targetQuery}&filter_expired=true&with_answer=true&answer_statuses=draft`, configIptvBase),
                    
                    // Rota de Pendentes Estruturada [Log 109]
                    axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo?expired_only=false&limit=100&offset=0&filter_expired=true&is_exam=false&with_answer=true&is_essay=false${targetQuery}&answer_statuses=draft&with_apply_moment=true`, configIptvBase),
                    
                    // Rota de Expiradas Estruturada [Log 112]
                    axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo?expired_only=true&limit=100&offset=0&filter_expired=false&is_exam=false&with_answer=true&is_essay=false${targetQuery}&answer_statuses=draft&with_apply_moment=true`, configIptvBase),

                    // Rota de Redações mantida para complemento do dashboard
                    axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&is_essay=true&filter_expired=true&with_answer=true`, configIptvBase)
                ]);

                // ----------------------------------------------------------
                // 5. PROCESSAMENTO E CORTE POR STATUS DE CONTEÚDO (answer_id)
                // ----------------------------------------------------------
                const rawPendentesList = Array.isArray(pendentesRaw.data) ? pendentesRaw.data : (pendentesRaw.data?.data || []);
                pendentes = rawPendentesList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                const rawExpiradasList = Array.isArray(expiradasRaw.data) ? expiradasRaw.data : (expiradasRaw.data?.data || []);
                expiradas = rawExpiradasList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.expire_at || t.end_date) >= dataInicioBimestre
                ).length;

                const rawRedacoesList = Array.isArray(redacoesRaw.data) ? redacoesRaw.data : (redacoesRaw.data?.data || []);
                redacoes = rawRedacoesList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                avaliacoes = surveyRes.data?.count || surveyRes.data?.required_count || 0;

            } catch (errBatch) {
                console.error(`[BFF CRITICAL] Falha na matriz de endpoints IP.TV:`, errBatch.response?.status || errBatch.message);
            }
        }

        // Retorno Limpo
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoFormatado, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: pendentes,
                expiradas: expiradas,
                avaliacoes: avaliacoes,
                redacoes: redacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Geral: ${error.message}`);
        res.status(500).json({ error: "Falha geral de agregação no barramento principal do BFF." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Matrix V2 ativo e operando na porta ${PORT}`));
